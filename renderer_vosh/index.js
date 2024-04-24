// http://localhost:8000/renderer/renderer.html?dir=../trial_bicycle_vosh-encoder/assets&quality=medium
// import createSceneMeshInVosh from "./mesh_in_vosh.js"



let gSceneMeshInVosh = null
let gRenderVosh = 1;

/**
 * Keeps track of whether loadOnFirstFrame has already been run.
 */
let gLoadOnFirstFrameRan = false;

/**
 * Number of already loaded textures.
 * @type {number}
 */
let gLoadedTextures = 0;

/**
 * Number of textures to load.
 * @type {number}
 */
let gNumTextures = 0;

/**
 * Our framerate display.
 * @type {?Object}
 */
let gStats = null;

/**
 * Different display modes for debugging rendering.
 * @enum {number}
 */
const DisplayModeType = {
    /** Runs the full model with view dependence. */
    DISPLAY_NORMAL: 0,
    /** Disables the view-dependence network. */
    DISPLAY_DIFFUSE: 1,
    /** Only shows the latent features. */
    DISPLAY_FEATURES: 2,
    /** Only shows the view dependent component. */
    DISPLAY_VIEW_DEPENDENT: 3,
    /** Only shows the coarse block grid. */
    DISPLAY_COARSE_GRID: 4,
    /** Only shows the rendered mesh*/
    DISPLAY_MESH: 5,
    /** Only shows the rendered volume*/
    DISPLAY_VOLUME: 6,
    /** Only shows the rendered mesh and grid*/
    DISPLAY_MESH_AND_GRID: 7,
};

/**  @type {!DisplayModeType}  */
let gDisplayMode = DisplayModeType.DISPLAY_NORMAL;

/**
 * Number of sample points per voxel.
 * @type {number}
 */
let gStepMult = 1;

/**
 * We control the camera using either orbit controls...
 * @type {?THREE.OrbitControls}
 */
let gOrbitControls = null;

/**
 * ...or for large scenes we use FPS-style controls.
 * @type {?THREE.PointerLockControls}
 */
let gPointerLockControls = null;

/**
 * The vertex shader for rendering a baked MERF scene with ray marching.
 * @const {string}
 */
const rayMarchVertexShader = `

varying vec3 vOrigin;
varying vec3 vDirection;
uniform mat4 world_T_clip;
varying vec2 vUv;

void main() {
  vec4 posClip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = posClip;

  posClip /= posClip.w;
  
  vec4 nearPoint = world_T_clip * vec4(posClip.x, posClip.y, -1.0, 1.0);
  vec4 farPoint = world_T_clip * vec4(posClip.x, posClip.y, 1.0, 1.0);

  vOrigin = nearPoint.xyz / nearPoint.w;
  vDirection = normalize(farPoint.xyz / farPoint.w - vOrigin);
  
  vUv = uv;
}
`;

/**
 * We build the ray marching shader programmatically, this string contains the
 * header for the shader.
 * @const {string}
 */
const rayMarchFragmentShaderHeader = `
varying vec3 vOrigin;
varying vec3 vDirection;

varying vec2 vUv;

uniform int displayMode;

uniform vec3 minPosition;
uniform mat3 worldspaceROpengl;
uniform float nearPlane;

uniform mat4 world_T_clip;
uniform mat4 inv_world_T_clip;

uniform highp sampler3D occupancyGrid_L0;
uniform highp sampler3D occupancyGrid_L1;
uniform highp sampler3D occupancyGrid_L2;
uniform highp sampler3D occupancyGrid_L3;
uniform highp sampler3D occupancyGrid_L4;

uniform float voxelSizeOccupancy_L0;
uniform float voxelSizeOccupancy_L1;
uniform float voxelSizeOccupancy_L2;
uniform float voxelSizeOccupancy_L3;
uniform float voxelSizeOccupancy_L4;

uniform vec3 gridSizeOccupancy_L0;
uniform vec3 gridSizeOccupancy_L1;
uniform vec3 gridSizeOccupancy_L2;
uniform vec3 gridSizeOccupancy_L3;
uniform vec3 gridSizeOccupancy_L4;

uniform highp sampler2D weightsZero;
uniform highp sampler2D weightsOne;
uniform highp sampler2D weightsTwo;

uniform int stepMult;
uniform float rangeFeaturesMin;
uniform float rangeFeaturesMax;
uniform float rangeDensityMin;
uniform float rangeDensityMax;

#ifdef USE_SPARSE_GRID
uniform vec3 sparseGridGridSize;
uniform float sparseGridVoxelSize;
uniform vec3 atlasSize;
uniform float dataBlockSize;
uniform highp sampler3D sparseGridRgb;
uniform highp sampler3D sparseGridDensity;
uniform highp sampler3D sparseGridFeatures;
uniform highp sampler3D sparseGridBlockIndices;
#endif

#ifdef USE_TRIPLANE
uniform vec2 triplaneGridSize;
uniform float triplaneVoxelSize;
// need to use texture arrays, otherwise we exceed max texture unit limit
uniform highp sampler2DArray planeRgb;
uniform highp sampler2DArray planeDensity;
uniform highp sampler2DArray planeFeatures;
#endif

uniform float cameraNear;
uniform float cameraFar;
uniform highp sampler2D tMeshClipPos;
uniform highp sampler2D tDepth;
uniform highp sampler2D tDiff;
uniform highp sampler2D tSpec;
`;

/**
 * Extends a dictionary.
 * @param {!object} obj Dictionary to extend
 * @param {!object} src Dictionary to be written into obj
 * @return {!object} Extended dictionary
 */
function extend(obj, src) {
    for (let key in src) {
        if (src.hasOwnProperty(key)) obj[key] = src[key];
    }
    return obj;
}

/**
 * Reports an error to the user by populating the error div with text.
 * @param {string} text
 */
function error(text) {
    const e = document.getElementById('error');
    e.textContent = text;
    e.style.display = 'block';
}

/**
 * Creates a DOM element that belongs to the given CSS class.
 * @param {string} what
 * @param {string} className
 * @return {!HTMLElement}
 */
function create(what, className) {
    const e = /** @type {!HTMLElement} */ (document.createElement(what));
    if (className) {
        e.className = className;
    }
    return e;
}

/**
 * Formats the integer i as a string with "min" leading zeroes.
 * @param {number} i
 * @param {number} min
 * @return {string}
 */
function digits(i, min) {
    const s = '' + i;
    if (s.length >= min) {
        return s;
    } else {
        return ('00000' + s).substr(-min);
    }
}

/**
 * Resizes a DOM element to the given dimensions.
 * @param {!Element} element
 * @param {number} width
 * @param {number} height
 */
function setDims(element, width, height) {
    element.style.width = width.toFixed(2) + 'px';
    element.style.height = height.toFixed(2) + 'px';
}

/**
 * Hides the loading prompt.
 */
function hideLoading() {
    let loading = document.getElementById('Loading');
    loading.style.display = 'none';

    let loadingContainer = document.getElementById('loading-container');
    loadingContainer.style.display = 'none';
}

/**
 * Executed whenever an image is loaded for updating the loading prompt.
 */
function onImageLoaded() {
    gLoadedTextures++;
    updateLoadingProgress();
}

/**
 * Updates the loading progress HTML elements.
 */
function updateLoadingProgress() {
    let imageProgress = document.getElementById('image-progress');
    const numTexturesString = gNumTextures > 0 ? gNumTextures : '?';
    imageProgress.innerHTML =
        'Loading images: ' + gLoadedTextures + '/' + numTexturesString;
}


/**
 * Returns a promise that fires within a specified amount of time. Can be used
 * in an asynchronous function for sleeping.
 * @param {number} milliseconds Amount of time to sleep
 * @return {!Promise}
 */
function sleep(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Safe fetching. Some servers restrict the number of requests and
 * respond with status code 429 ("Too Many Requests") when a threshold
 * is exceeded. When we encounter a 429 we retry after a short waiting period.
 * @param {!object} fetchFn Function that fetches the file.
 * @return {!Promise} Returns fetchFn's response.
 */
async function fetchAndRetryIfNecessary(fetchFn) {
    const response = await fetchFn();
    if (response.status === 429) {
        await sleep(500);
        return fetchAndRetryIfNecessary(fetchFn);
    }
    return response;
}

/**
 * Loads PNG image from rgbaURL and decodes it to an Uint8Array.
 * @param {string} rgbaUrl The URL of the PNG image.
 * @return {!Promise<!Uint8Array>}
 */
function loadPNG(rgbaUrl) {
    let fetchFn = () => fetch(rgbaUrl, {method: 'GET', mode: 'cors'});
    const rgbaPromise = fetchAndRetryIfNecessary(fetchFn)
        .then(response => {
            return response.arrayBuffer();
        })
        .then(buffer => {
            let data = new Uint8Array(buffer);
            let pngDecoder = new PNG(data);
            let pixels = pngDecoder.decodePixels();
            return pixels;
        });
    rgbaPromise.catch(error => {
        console.error('Could not PNG image from: ' + rgbaUrl + ', error: ' + error);
        return;
    });
    return rgbaPromise;
}

/**
 * Loads a text file.
 * @param {string} url URL of the file to be loaded.
 * @return {!Promise<string>}
 */
function loadTextFile(url) {
    let fetchFn = () => fetch(url, {
        method: 'GET',
        mode: 'cors',
    });
    return fetchAndRetryIfNecessary(fetchFn).then(response => response.text());
}

/**
 * Loads and parses a JSON file.
 * @param {string} url URL of the file to be loaded
 * @return {!Promise<!object>} The parsed JSON file
 */
function loadJSONFile(url) {
    let fetchFn = () => fetch(url, {
        method: 'GET',
        mode: 'cors',
    });
    return fetchAndRetryIfNecessary(fetchFn).then(response => response.json());
}

/**
 * Creates an empty volume texture.
 * @param {number} width Width of the texture
 * @param {number} height Height of the texture
 * @param {number} depth Depth of the texture
 * @param {number} format Format of the texture
 * @param {number} filter Filter strategy of the texture
 * @return {!THREE.DataTexture3D} Volume texture
 */
function createEmptyVolumeTexture(width, height, depth, format, filter) {
    volumeTexture = new THREE.DataTexture3D(null, width, height, depth);
    volumeTexture.format = format;
    volumeTexture.generateMipmaps = false;
    volumeTexture.magFilter = volumeTexture.minFilter = filter;
    volumeTexture.wrapS = volumeTexture.wrapT = volumeTexture.wrapR =
        THREE.ClampToEdgeWrapping;
    volumeTexture.type = THREE.UnsignedByteType;
    return volumeTexture;
}

/**
 * Uploads a volume slice to a pre-existing volume texture.
 * @param {!Uint8Array} volumeSlice Data to be uploaded
 * @param {!THREE.DataTexture3D} texture Volume texture to upload to
 * @param {number} sliceIndex Index of the slice
 * @param {number} volumeWidth Width of the volume
 * @param {number} volumeHeight Height of the volume
 * @param {number} sliceDepth Depth of slice
 */
function uploadVolumeSlice(
    volumeSlice, texture, sliceIndex, volumeWidth, volumeHeight, sliceDepth) {
    const textureProperties = gRenderer['properties'].get(texture);
    let gl = gRenderer.getContext();

    let stride, glFormat;
    if (texture.format == THREE.RGBAFormat) {
        glFormat = gl.RGBA;
        stride = 4;
    } else if (texture.format == THREE.RGBFormat) {
        glFormat = gl.RGB;
        stride = 3;
    } else if (texture.format == THREE.RedFormat) {
        glFormat = gl.RED;
        stride = 1;
    }

    let oldTexture = gl.getParameter(gl.TEXTURE_BINDING_3D);
    let textureHandle = textureProperties['__webglTexture'];
    gl.bindTexture(gl.TEXTURE_3D, textureHandle);
    // Upload row-by-row to work around bug with Intel + Mac OSX.
    // See https://crbug.com/654258.
    for (let z = 0; z < sliceDepth; ++z) {
        for (let y = 0; y < volumeHeight; ++y) {
            gl.texSubImage3D(
                gl.TEXTURE_3D, 0, 0, y, z + sliceIndex * sliceDepth, volumeWidth, 1,
                1, glFormat, gl.UNSIGNED_BYTE, volumeSlice,
                stride * volumeWidth * (y + volumeHeight * z));
        }
    }
    gl.bindTexture(gl.TEXTURE_3D, oldTexture);
}

/**
 * Loads a volume texture slice-by-slice.
 * @param {!object} uploadFn Function that is called when a new volume slice is received.
 * Uploads function to texture.
 * @param {number} numSlices Total number of slices
 * @param {number} sliceDepth Depth of slice
 * @param {number} volumeWidth Width of the volume
 * @param {number} volumeHeight Height of the volume
 * @param {number} volumeDepth Depth of the volume
 * @param {string} filenamePrefix The string all filenames start with. The slice
 * index and the png file ending are appended to this string.
 * @param {!object} filenameToLinkTranslator
 * @return {!Promise} Resolves when the texture is fully uploaded
 */
function loadVolumeTextureSliceBySlice(
    uploadFn, numSlices, sliceDepth, volumeWidth, volumeHeight, volumeDepth,
    filenamePrefix, filenameToLinkTranslator) {
    let uploadPromises = [];
    for (let sliceIndex = 0; sliceIndex < numSlices; sliceIndex++) {
        let url = filenameToLinkTranslator.translate(filenamePrefix + '_' + digits(sliceIndex, 3) + '.png');
        let rgbaPromise = loadPNG(url);
        rgbaPromise = rgbaPromise.then(data => {
            onImageLoaded();
            return data;
        });

        let uploadPromise = new Promise(function (resolve, reject) {
            rgbaPromise
                .then(rgbaImage => {
                    uploadFn(rgbaImage, sliceIndex, volumeWidth, volumeHeight, sliceDepth);
                    resolve();
                })
                .catch(error => {
                    reject(error);
                });
        });
        uploadPromises.push(uploadPromise);
    }
    return Promise.all(uploadPromises);
}

/**
 * Creates three equally sized textures to hold triplanes.
 * @param {number} width Width of the texture
 * @param {number} height Height of the texture
 * @param {number} format Format of the texture
 * @return {!THREE.DataTexture2DArray} Texture array of size three
 */
function createEmptyTriplaneTextureArray(width, height, format) {
    let texture = new THREE.DataTexture2DArray(null, width, height, 3);
    texture.format = format;
    texture.generateMipmaps = false;
    texture.magFilter = texture.minFilter = THREE.LinearFilter;
    texture.wrapS = texture.wrapT = texture.wrapR = THREE.ClampToEdgeWrapping;
    texture.type = THREE.UnsignedByteType;
    return texture;
}

/**
 * Translates filenames to links.
 */
class FilenameToLinkTranslator {
    /** Constructor.
     * @param {string} dirUrl The url where scene files are stored.
     * @param {?object} filenameToLink Dictionary that maps interal file names to download links.
     */
    constructor(dirUrl, filenameToLink) {
        this.dirUrl = dirUrl;
        this.filenameToLink = filenameToLink;
    }

    /** Maps a virtual filename to an URL.
     * @param {string} filename Internal filename.
     * @return {string} Download URL.
     */
    translate(filename) {
        if (this.filenameToLink != null) {
            // Lookup download URL in map.
            return this.filenameToLink[filename];
        } else {
            // Simply prepend directory.
            return this.dirUrl + '/' + filename;
        }
    }
}

const voshVertexShader = `
varying vec2 vUv;

void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const voshFragmentShader = `
uniform int displayMode;
varying vec2 vUv;

uniform highp sampler2D tDiffuse;
uniform highp sampler2D tSpecular;

layout(location = 0) out vec4 tDiff;
layout(location = 1) out vec4 tSpec;

void main() {
    // See the DisplayMode enum at the top of this file.
    // Runs the full model with view dependence.
    const int DISPLAY_NORMAL = 0;
    // Disables the view-dependence network.
    const int DISPLAY_DIFFUSE = 1;
    // Only shows the latent features.
    const int DISPLAY_FEATURES = 2;
    // Only shows the view dependent component.
    const int DISPLAY_VIEW_DEPENDENT = 3;
    // Only shows the coarse block grid.
    const int DISPLAY_COARSE_GRID = 4;
    // Only shows the rendered mesh
    const int DISPLAY_MESH = 5;
    // Only shows the rendered volume
    const int DISPLAY_VOLUME = 6;
    // Only shows the rendered mesh and grid
    const int DISPLAY_MESH_AND_GRID = 7;
    
    int use_displayMode = displayMode;
    
    vec4 diffuse = vec4(texture(tDiffuse, vUv).rgb, 1.0);
    vec4 spec = texture(tSpecular, vUv);

    if (use_displayMode == DISPLAY_COARSE_GRID) {
        tDiff = vec4(0.0, 0.0, 0.0, 1.0);
        tSpec = vec4(0.0, 0.0, 0.0, 1.0);
    } else {
        tDiff = diffuse;
        if (use_displayMode == DISPLAY_DIFFUSE) { // diffuse
            tSpec = vec4(0.0, 0.0, 0.0, 1.0);
        } else {
            tSpec = spec;
        }
    }
}
`;

function loadMeshAssets(meshUrl, cas_num) {
    console.log("[INFO] loading:", meshUrl);
    let promises = [];

    for (let cas = 0; cas < cas_num; cas++) {
        let newmat = null;

        promises.push(new Promise((resolve) => {
            new GLTFLoader().load(meshUrl + '/mesh_' + cas.toString() + '.glb', object => {
            // new DRACOLoader().load(meshUrl + '/mesh_' + cas.toString() + '.drc', object => {

                // load feature texture

                let tex0 = new THREE.TextureLoader().load(meshUrl + '/feat0_' + cas.toString() + '.jpg', object => {
                    console.log('[INFO] loaded diffuse tex:', meshUrl + '/feat0_' + cas.toString() + '.jpg');
                    object.format = THREE.RGBFormat;
                    object.generateMipmaps = false;
                    object.magFilter = object.minFilter = THREE.LinearFilter;
                    object.wrapS = object.wrapT = object.wrapR = THREE.ClampToEdgeWrapping;
                    object.type = THREE.UnsignedByteType;
                    // object.type = THREE.FloatType;
                    object.colorSpace = THREE.SRGBColorSpace;
                    object.flipY = false;
                });
                let tex1 = new THREE.TextureLoader().load(meshUrl + '/feat1_' + cas.toString() + '.png', object => {
                    console.log('[INFO] loaded specular tex:', meshUrl + '/feat1_' + cas.toString() + '.png');
                    object.format = THREE.RGBAFormat;
                    object.generateMipmaps = false;
                    object.magFilter = object.minFilter = THREE.LinearFilter;
                    object.wrapS = object.wrapT = object.wrapR = THREE.ClampToEdgeWrapping;
                    object.type = THREE.UnsignedByteType;
                    // object.type = THREE.FloatType;
                    object.colorSpace = THREE.SRGBColorSpace;
                    object.flipY = false;
                });

                voshmat = new THREE.ShaderMaterial({
                    side: THREE.DoubleSide,
                    vertexShader: voshVertexShader,
                    vertexColors: true,
                    fragmentShader: voshFragmentShader,
                    uniforms: {
                        tDiffuse: {value: tex0},
                        tSpecular: {value: tex1},
                        displayMode: {'value': gDisplayMode - 0},
                    },
                    glslVersion: THREE.GLSL3,
                });
                voshmat.needsUpdate = true;

                object.scene.traverse(function (child) {
                    if (child.type === 'Mesh') {
                        child.material = voshmat;
                        child.position.set(0, 0, 0);
                        child.scale.set(1, 1, 1);
                        child.rotation.set(-Math.PI * 0.5, 0, -Math.PI * 0.5);
                    }
                });

                console.log('[INFO] loaded mesh:', meshUrl + '/mesh_' + cas.toString() + '.obj');
                resolve(object.scene);
            });
        }));
    }
    return Promise.all(promises)
}

/**
 * Loads the MERF scene.
 * @param {string} dirUrl Either points to a directory that contains scene files
 *                        or to a json file that maps virtual filenames to
 *                        download links
 * @param {number} width Width of the viewer frame
 * @param {number} height Height of the viewer frame
 * @param {!bool} useLargerStepsWhenOccluded Enables a hack that speeds up
 * rendering by using a larger step size with decreasing visibility
 * @param {number} nearPlane Distance to the near clipping plane
 */
function loadScene(
    dirUrl, width, height, useLargerStepsWhenOccluded, nearPlane, is_object_data, cas_num) {
    // Check if dirUrl points to a json file or to a directory.
    if (dirUrl.includes('.json')) {
        // If this is the case, we fetch a JSON file that maps filenames to links.
        filenameToLinkPromise = loadJSONFile(dirUrl);
    } else {
        // Otherwise, the scene files directly lie at dirUrl and we create a
        // dummy promise that resolves immediately.
        filenameToLinkPromise = Promise.resolve(null);
    }

    filenameToLinkPromise.then(filenameToLink => {
        const filenameToLinkTranslator =
            new FilenameToLinkTranslator(dirUrl, filenameToLink);

        let meshUrl =
            filenameToLinkTranslator.translate('mesh');
        let meshPromise = loadMeshAssets(meshUrl, cas_num=cas_num);
        meshPromise.then(parsed => {
            gSceneMeshInVosh = new THREE.Scene();
            // gSceneMeshInVosh.add(parsed[0]);
            for(let i=0;i<parsed.length;i++){
                gSceneMeshInVosh.add(parsed[i]);
            }

            // Loads scene parameters (voxel grid size, view-dependence MLP).
            let sceneParamsUrl =
                filenameToLinkTranslator.translate('scene_params.json');
            let sceneParamsPromise = loadJSONFile(sceneParamsUrl);

            sceneParamsPromise.catch(error => {
                console.error(
                    'Could not load scene params from: ' + sceneParamsUrl + ', error: ' + error);
                return;
            });

            // Some of the shader code is stored in seperate files.
            viewdepdencyShaderPromise = loadTextFile('viewdependency.glsl');
            if(is_object_data){
                fragmentShaderPromise = loadTextFile('fragment_object.glsl');
            }else{
                fragmentShaderPromise = loadTextFile('fragment.glsl');
            }
            textPromises =
                [sceneParamsPromise, viewdepdencyShaderPromise, fragmentShaderPromise];

            let occupancyGridBlockSizes = [8, 16, 32, 64, 128];
            gNumTextures = occupancyGridBlockSizes.length;
            let occupancyGridPromises = [];
            for (let occupancyGridIndex = 0;
                 occupancyGridIndex < occupancyGridBlockSizes.length;
                 occupancyGridIndex++) {
                let occupancyGridUrl = filenameToLinkTranslator.translate(
                    'occupancy_grid_' + occupancyGridBlockSizes[occupancyGridIndex] +
                    '.png');
                let occupancyGridPromise = loadPNG(occupancyGridUrl);
                occupancyGridPromises.push(occupancyGridPromise);
            }
            textPromises = Promise.all(textPromises);

            textPromises.then(parsed => {
                sceneParams = parsed[0];
                viewDependenceNetworkShaderFunctions = parsed[1];
                rayMarchFragmentShaderBody = parsed[2];

                useSparseGrid = sceneParams['sparse_grid_resolution'] > 0;
                let sparseGridBlockIndicesPromise;
                if (useSparseGrid) {
                    // Load the indirection grid.
                    let sparseGridBlockIndicesUrl =
                        filenameToLinkTranslator.translate('sparse_grid_block_indices.png');
                    sparseGridBlockIndicesPromise = loadPNG(sparseGridBlockIndicesUrl);
                    gNumTextures += 2 * sceneParams['num_slices'];
                }

                let planePromises = [];
                let useTriplane = sceneParams['triplane_resolution'] > 0;
                if (useTriplane) {
                    gNumTextures += 6;
                    for (let plane_idx = 0; plane_idx < 3; ++plane_idx) {
                        let planeUrl = filenameToLinkTranslator.translate(
                            'plane_rgb_and_density_' + plane_idx + '.png');
                        let planePromise = loadPNG(planeUrl);
                        planePromise.then(unused => onImageLoaded());
                        planePromises.push(planePromise);
                        planeUrl = filenameToLinkTranslator.translate(
                            'plane_features_' + plane_idx + '.png');
                        planePromise = loadPNG(planeUrl);
                        planePromises.push(planePromise);
                        planePromise.then(unused => onImageLoaded());
                    }
                }
                planePromises = Promise.all(planePromises);
                updateLoadingProgress();

                // Load sparse grid, note that textures are only allocated and
                // the actual loading is done progressively in loadOnFirstFrame.
                let sparseGridRgbTexture = null;
                let sparseGridDensityTexture = null;
                let sparseGridFeaturesTexture = null;
                let sparseGridBlockIndicesTexture = null;
                if (useSparseGrid) {
                    // Create empty volume textures that are lately filled slice-by-slice
                    function _createEmptyAtlasVolumeTexture(format) {
                        return createEmptyVolumeTexture(
                            sceneParams['atlas_width'], sceneParams['atlas_height'],
                            sceneParams['atlas_depth'], format, THREE.LinearFilter);
                    }

                    // All of these textures have the same dimensions and use linear
                    // filtering.
                    sparseGridRgbTexture = _createEmptyAtlasVolumeTexture(THREE.RGBFormat);
                    sparseGridDensityTexture =
                        _createEmptyAtlasVolumeTexture(THREE.RedFormat);
                    sparseGridFeaturesTexture =
                        _createEmptyAtlasVolumeTexture(THREE.RGBAFormat);

                    // The indirection grid uses nearest filtering and is loaded in one go.
                    let v = sceneParams['sparse_grid_resolution'] /
                        sceneParams['data_block_size'];
                    sparseGridBlockIndicesTexture = createEmptyVolumeTexture(
                        v, v, v, THREE.RGBFormat, THREE.NearestFilter);
                    sparseGridBlockIndicesPromise.then(sparseGridBlockIndicesImage => {
                        sparseGridBlockIndicesTexture.image.data =
                            sparseGridBlockIndicesImage;
                        sparseGridBlockIndicesTexture.needsUpdate = true;
                    });
                }

                // Load triplanes.
                let planeRgbTexture, planeDensityTexture, planeFeaturesTexture,
                    triplaneGridSize;
                if (useTriplane) {
                    let triplaneResolution = sceneParams['triplane_resolution'];
                    let triplaneNumTexels = triplaneResolution * triplaneResolution;
                    triplaneGridSize =
                        new THREE.Vector2(triplaneResolution, triplaneResolution);
                    planeRgbTexture = createEmptyTriplaneTextureArray(
                        triplaneResolution, triplaneResolution, THREE.RGBFormat);
                    planeDensityTexture = createEmptyTriplaneTextureArray(
                        triplaneResolution, triplaneResolution, THREE.RedFormat);
                    planeFeaturesTexture = createEmptyTriplaneTextureArray(
                        triplaneResolution, triplaneResolution, THREE.RGBAFormat);
                    planePromises.then(planeData => {
                        let planeRgbStack = new Uint8Array(3 * triplaneNumTexels * 3);
                        let planeDensityStack = new Uint8Array(3 * triplaneNumTexels);
                        let planeFeaturesStack =
                            new Uint8Array(3 * triplaneNumTexels * 4);
                        for (let plane_idx = 0; plane_idx < 3; plane_idx++) {
                            let baseOffset = plane_idx * triplaneNumTexels;
                            let planeRgbAndDensity = planeData[2 * plane_idx];
                            let planeFeatures = planeData[2 * plane_idx + 1];
                            for (let j = 0; j < triplaneNumTexels; j++) {
                                planeRgbStack[(baseOffset + j) * 3 + 0] = planeRgbAndDensity[j * 4 + 0];
                                planeRgbStack[(baseOffset + j) * 3 + 1] = planeRgbAndDensity[j * 4 + 1];
                                planeRgbStack[(baseOffset + j) * 3 + 2] = planeRgbAndDensity[j * 4 + 2];
                                planeDensityStack[baseOffset + j] = planeRgbAndDensity[j * 4 + 3];
                                planeFeaturesStack[(baseOffset + j) * 4 + 0] = planeFeatures[j * 4 + 0];
                                planeFeaturesStack[(baseOffset + j) * 4 + 1] = planeFeatures[j * 4 + 1];
                                planeFeaturesStack[(baseOffset + j) * 4 + 2] = planeFeatures[j * 4 + 2];
                                planeFeaturesStack[(baseOffset + j) * 4 + 3] = planeFeatures[j * 4 + 3];
                            }
                        }
                        planeRgbTexture.image.data = planeRgbStack;
                        planeRgbTexture.needsUpdate = true;
                        planeDensityTexture.image.data = planeDensityStack;
                        planeDensityTexture.needsUpdate = true;
                        planeFeaturesTexture.image.data = planeFeaturesStack;
                        planeFeaturesTexture.needsUpdate = true;
                    });
                }

                // Load occupancy grids for empty space skipping.
                let resolutionToUse, voxelSizeToUse;
                if (useTriplane) {
                    resolutionToUse = sceneParams['triplane_resolution'];
                    voxelSizeToUse = sceneParams['triplane_voxel_size'];
                } else {
                    resolutionToUse = sceneParams['sparse_grid_resolution'];
                    voxelSizeToUse = sceneParams['sparse_grid_voxel_size'];
                }
                let occupancyGridTextures = [];
                let occupancyGridSizes = [];
                let occupancyVoxelSizes = [];
                for (let occupancyGridIndex = 0; occupancyGridIndex < occupancyGridBlockSizes.length;
                     occupancyGridIndex++) {
                    let occupancyGridBlockSize = occupancyGridBlockSizes[occupancyGridIndex];
                    // Assuming width = height = depth which typically holds when employing
                    // scene contraction.
                    let v = Math.ceil(resolutionToUse / occupancyGridBlockSize);
                    let occupancyGridTexture = createEmptyVolumeTexture(
                        v, v, v, THREE.RedFormat, THREE.NearestFilter);
                    occupancyGridTextures.push(occupancyGridTexture);
                    occupancyGridSizes.push(new THREE.Vector3(v, v, v));
                    occupancyVoxelSizes.push(voxelSizeToUse * occupancyGridBlockSize);
                    occupancyGridPromises[occupancyGridIndex].then(
                        occupancyGridImageFourChannels => {
                            onImageLoaded();
                            let occupancyGridImage = new Uint8Array(v * v * v);
                            for (let j = 0; j < v * v * v; j++) {
                                occupancyGridImage[j] = occupancyGridImageFourChannels[4 * j];
                            }
                            occupancyGridTexture.image.data = occupancyGridImage;
                            occupancyGridTexture.needsUpdate = true;
                        });
                }

                // Assemble shader code from header, on-the-fly generated view-dependency
                // functions and body.
                let fragmentShaderSource = rayMarchFragmentShaderHeader;
                fragmentShaderSource += createViewDependenceFunctions(
                    sceneParams, viewDependenceNetworkShaderFunctions);
                fragmentShaderSource += rayMarchFragmentShaderBody;

                // Upload networks weights into textures (biases are written as
                // compile-time constants into the shader).
                let weightsTexZero = createNetworkWeightTexture(sceneParams['0_weights']);
                let weightsTexOne = createNetworkWeightTexture(sceneParams['1_weights']);
                let weightsTexTwo = createNetworkWeightTexture(sceneParams['2_weights']);

                let worldspaceROpengl = new THREE.Matrix3();
                worldspaceROpengl.set(0,0,1,1,0,0,0,1,0);
                let minPosition = new THREE.Vector3(-2.0, -2.0, -2.0);

                // Pass uniforms to the shader.
                let rayMarchUniforms = {
                    'occupancyGrid_L4': {'value': occupancyGridTextures[0]},
                    'occupancyGrid_L3': {'value': occupancyGridTextures[1]},
                    'occupancyGrid_L2': {'value': occupancyGridTextures[2]},
                    'occupancyGrid_L1': {'value': occupancyGridTextures[3]},
                    'occupancyGrid_L0': {'value': occupancyGridTextures[4]},
                    'voxelSizeOccupancy_L4': {'value': occupancyVoxelSizes[0]},
                    'voxelSizeOccupancy_L3': {'value': occupancyVoxelSizes[1]},
                    'voxelSizeOccupancy_L2': {'value': occupancyVoxelSizes[2]},
                    'voxelSizeOccupancy_L1': {'value': occupancyVoxelSizes[3]},
                    'voxelSizeOccupancy_L0': {'value': occupancyVoxelSizes[4]},
                    'gridSizeOccupancy_L4': {'value': occupancyGridSizes[0]},
                    'gridSizeOccupancy_L3': {'value': occupancyGridSizes[1]},
                    'gridSizeOccupancy_L2': {'value': occupancyGridSizes[2]},
                    'gridSizeOccupancy_L1': {'value': occupancyGridSizes[3]},
                    'gridSizeOccupancy_L0': {'value': occupancyGridSizes[4]},

                    'displayMode': {'value': gDisplayMode - 0},
                    'nearPlane': {'value': nearPlane},
                    'minPosition': {'value': minPosition},
                    'weightsZero': {'value': weightsTexZero},
                    'weightsOne': {'value': weightsTexOne},
                    'weightsTwo': {'value': weightsTexTwo},
                    'world_T_clip': {'value': new THREE.Matrix4()},
                    'inv_world_T_clip': {'value': new THREE.Matrix4()},

                    'worldspaceROpengl': {'value': worldspaceROpengl},

                    'stepMult': {'value': gStepMult},
                    'rangeFeaturesMin': {'value': sceneParams['range_features'][0]},
                    'rangeFeaturesMax': {'value': sceneParams['range_features'][1]},
                    'rangeDensityMin': {'value': sceneParams['range_density'][0]},
                    'rangeDensityMax': {'value': sceneParams['range_density'][1]},

                    'tDepth': {'value': new THREE.Matrix4()},
                    'tDiff': {'value': new THREE.Matrix4()},
                    'tSpec': {'value': new THREE.Matrix4()},
                    'gRenderVosh': {'value': gRenderVosh},
                };

                has_vol = sceneParams['has_vol'];
                console.log("has_vol:" + has_vol);
                if(has_vol){
                    fragmentShaderSource = '#define HAS_VOL\n' + fragmentShaderSource;
                }

                if (useTriplane) {
                    let triplaneUniforms = {
                        'planeRgb': {'value': planeRgbTexture},
                        'planeDensity': {'value': planeDensityTexture},
                        'planeFeatures': {'value': planeFeaturesTexture},
                        'triplaneGridSize': {'value': triplaneGridSize},
                        'triplaneVoxelSize': {'value': sceneParams['triplane_voxel_size']},
                    };
                    rayMarchUniforms = extend(rayMarchUniforms, triplaneUniforms);
                    fragmentShaderSource = '#define USE_TRIPLANE\n' + fragmentShaderSource;
                }
                if (useSparseGrid) {
                    let sparseGridUniforms = {
                        'sparseGridRgb': {'value': sparseGridRgbTexture},
                        'sparseGridDensity': {'value': sparseGridDensityTexture},
                        'sparseGridFeatures': {'value': sparseGridFeaturesTexture},
                        'sparseGridBlockIndices': {'value': sparseGridBlockIndicesTexture},
                        'dataBlockSize': {'value': sceneParams['data_block_size']},
                        'sparseGridVoxelSize':
                            {'value': sceneParams['sparse_grid_voxel_size']},
                        'sparseGridGridSize': {
                            'value': new THREE.Vector3(
                                sceneParams['sparse_grid_resolution'],
                                sceneParams['sparse_grid_resolution'],
                                sceneParams['sparse_grid_resolution'])
                        },
                        'atlasSize': {
                            'value': new THREE.Vector3(
                                sceneParams['atlas_width'], sceneParams['atlas_height'],
                                sceneParams['atlas_depth'])
                        },
                    };
                    rayMarchUniforms = extend(rayMarchUniforms, sparseGridUniforms);
                    fragmentShaderSource = '#define USE_SPARSE_GRID\n' + fragmentShaderSource;
                }
                if (useLargerStepsWhenOccluded) {
                    fragmentShaderSource = '#define LARGER_STEPS_WHEN_OCCLUDED\n' + fragmentShaderSource;
                }

                // Bundle uniforms, vertex and fragment shader in a material
                let rayMarchMaterial = new THREE.ShaderMaterial({
                    uniforms: rayMarchUniforms,
                    vertexShader: rayMarchVertexShader,
                    fragmentShader: fragmentShaderSource,
                    vertexColors: true,
                });
                rayMarchMaterial.side = THREE.DoubleSide;
                rayMarchMaterial.depthTest = false;
                rayMarchMaterial.needsUpdate = true;

                // Create a proxy plane.
                let fullScreenPlane = new THREE.PlaneBufferGeometry(width, height);

                let fullScreenPlaneMesh = new THREE.Mesh(fullScreenPlane, rayMarchMaterial);
                fullScreenPlaneMesh.position.z = -100;
                fullScreenPlaneMesh.frustumCulled = false;

                gRayMarchScene = new THREE.Scene();
                gRayMarchScene.add(fullScreenPlaneMesh);
                gRayMarchScene.autoUpdate = false;

                // Start rendering ASAP, forcing THREE.js to upload the textures.
                requestAnimationFrame(
                    t => update(t, dirUrl, filenameToLinkTranslator, useSparseGrid, sceneParams, cas_num=cas_num)
                );
            });
        });
    });
}

/**
 * Initializes the application based on the URL parameters.
 */
function initFromParameters() {
    const params = new URL(window.location.href).searchParams;
    //mip-nerf360 dataset
    // const is_object_data = false;
    // const cas_num = 3;

    //nerf_synthetic dataset
    // const is_object_data = true;
    // const cas_num = 1;

    const dirUrl = params.get('dir');
    const is_object_data_str = params.get('is_object');
    const cas_num = params.get('cas_num');

    const is_object_data = is_object_data_str === 'true';
    // const is_object_data = true;
    // const cas_num = 1;
    

    console.log("is_object_data:" + is_object_data);
    console.log(cas_num);


    // const dirUrl = '../Assets/bicycle_base/assets'
    // const dirUrl = '../Assets/garden_base/assets'
    // const dirUrl = '../Assets/stump_base/assets'
    
    // const dirUrl = '../Assets/bicycle_light/assets'
    // const dirUrl = '../Assets/garden_light/assets'
    // const dirUrl = '../Assets/stump_light/assets'
    // const dirUrl = '../Assets/bicycle_test/assets'





    // const dirUrl = '../Assets/chair_light/assets'
    // const dirUrl = '../Assets/ficus_light/assets'
    // const dirUrl = '../Assets/mic_light/assets'
    // const dirUrl = '../Assets/ship_light/assets'
    // const dirUrl = '../Assets/lego_light/assets'
    // const dirUrl = '../Assets/materials_light/assets'
    // const dirUrl = '../Assets/hotdog_light/assets'
    // const dirUrl = '../Assets/drums_light/assets'
    
    
    // const dirUrl = '../Assets/chair_base/assets'
    // const dirUrl = '../Assets/ficus_base/assets'
    // const dirUrl = '../Assets/mic_base/assets'
    // const dirUrl = '../Assets/ship_base/assets'
    // const dirUrl = '../Assets/lego_base/assets'
    // const dirUrl = '../Assets/materials_base/assets'
    // const dirUrl = '../Assets/hotdog_base/assets'
    // const dirUrl = '../Assets/drums_base/assets'

    // const dirUrl = '../Assets/chair_base_old/assets'
    // const dirUrl = '../Assets/bicycle_test/assets'
    // const dirUrl = '../Assets/stump_test/assets'

    // const dirUrl = '../Assets/lego_small_light/assets'
    // const dirUrl = '../Assets/ficus_small_light/assets'
    // const dirUrl = '../Assets/ship_small_light/assets'
    // const dirUrl = '../Assets/hotdog_small_light/assets'

    const size = params.get('s');

    const quality = params.get('quality');
    // const quality = 'low';  // phone, low, medium, high
    // const quality = 'medium';
    // const quality = 'high';


    const stepMult = params.get('stepMult');
    if (stepMult) {
        gStepMult = parseInt(stepMult, 10);
    }

    const usageString =
        'To view a Vosh scene, specify the following parameters in the URL:\n' +
        '(Required) The URL to a Vosh scene directory.\n' +
        's: (Optional) The dimensions as width,height. E.g. 640,360.\n' +
        'vfovy:  (Optional) The vertical field of view of the viewer.';

    if (!dirUrl) {
        error('dir is a required parameter.\n\n' + usageString);
        return;
    }

    // Default to filling the browser window, and rendering at full res.
    let frameBufferWidth = window.innerWidth - 46;  // Body has a padding of 20x, we have a border of 3px.
    let frameBufferHeight = window.innerHeight - 46;
    // let lowResFactor = parseInt(params.get('downscale') || 1, 10);


    // frameBufferWidth = 1920;
    // frameBufferHeight = 1080;


    if (size) {
        const match = size.match(/([\d]+),([\d]+)/);
        frameBufferWidth = parseInt(match[1], 10);
        frameBufferHeight = parseInt(match[2], 10);
    } else if (quality) {
        // No size specified, clip the max viewport size based on quality.
        if (quality == 'phone') {  // For iPhones.
            frameBufferWidth = Math.min(350, frameBufferWidth);
            frameBufferHeight = Math.min(600, frameBufferHeight);
        } else if (quality == 'low') {  // For laptops with integrated GPUs.
            frameBufferWidth = Math.min(1200, frameBufferWidth);
            frameBufferHeight = Math.min(800, frameBufferHeight);
        } else if (quality == 'medium') {  // For laptops with dicrete GPUs.
            frameBufferWidth = Math.min(1920, frameBufferWidth);
            frameBufferHeight = Math.min(1080, frameBufferHeight);
        }  // else assume quality is 'high' and render at full res.
    }

    console.log('frameBuffer size: ' + frameBufferWidth + ' ' + frameBufferHeight);
    // console.log('Downscaling factor: ' + lowResFactor);

    useLargerStepsWhenOccluded = quality != 'high';

    const nearPlane = parseFloat(params.get('near') || 0.2);
    const vfovy = parseFloat(params.get('vfovy') || 35);

    console.log("neraplane:" + nearPlane)
    console.log("vfovy:" + vfovy)

    const view = create('div', 'view');
    setDims(view, frameBufferWidth, frameBufferHeight);
    view.textContent = '';

    const viewSpaceContainer = document.getElementById('viewspacecontainer');
    viewSpaceContainer.style.display = 'inline-block';

    const viewSpace = document.querySelector('.viewspace');
    viewSpace.textContent = '';
    viewSpace.appendChild(view);

    let canvas = document.createElement('canvas');
    view.appendChild(canvas);

    gStats = new Stats();

    viewSpace.appendChild(gStats.dom);
    gStats.dom.style.position = 'absolute';

    

    // Set up a high performance WebGL context, making sure that anti-aliasing is
    // turned off.
    let gl = canvas.getContext('webgl2');
    gRenderer = new THREE.WebGLRenderer({
        canvas: canvas,
        context: gl,
        powerPreference: 'high-performance',
        alpha: false,
        stencil: false,
        precision: 'mediump',
        depth: false,
        antialias: false,
        desynchronized: true
    });
    // gRenderer.gammaOutput = true;
    // gRenderer.gammaFactor = 2.2;   //电脑显示屏的gammaFactor为2.2


    // Set up the normal scene used for rendering.
    gCamera = new THREE.PerspectiveCamera(
        72,
        Math.trunc(view.offsetWidth) /
        Math.trunc(view.offsetHeight),
        nearPlane, 100.0);
    gCamera.fov = vfovy;
    setupProgressiveRendering(view);
    gRenderer.autoClear = false;
    gRenderer.setSize(view.offsetWidth, view.offsetHeight);


    const displayModeSelect = document.getElementById('display-mode');

    displayModeSelect.addEventListener('change', function() {
        const selectedValue = displayModeSelect.value;
        const selectedText = displayModeSelect.options[displayModeSelect.selectedIndex].text;
        console.log('Selected Value:', selectedValue);
        console.log('Selected Text:', selectedText);
        // 在这里可以添加任何其他处理逻辑
        gDisplayMode = selectedValue;
        displayModeSelect.text 

    });

    const mouseMode = params.get('mouseMode');
    setupCameraControls(mouseMode, view);
    setupInitialCameraPose(dirUrl);
    loadScene(
        dirUrl, Math.trunc(view.offsetWidth),
        Math.trunc(view.offsetHeight), useLargerStepsWhenOccluded,
        nearPlane,
        is_object_data,
        cas_num);
}

/**
 * Checks whether the WebGL context is valid and the underlying hardware is
 * powerful enough. Otherwise displays a warning.
 * @return {boolean}
 */
function isRendererUnsupported() {
    let loading = document.getElementById('Loading');

    let gl = document.getElementsByTagName('canvas')[0].getContext('webgl2');
    if (!gl) {
        loading.innerHTML = 'Error: WebGL2 context not found. Is your machine' +
            ' equipped with a discrete GPU?';
        return true;
    }

    let debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    if (!debugInfo) {
        loading.innerHTML = 'Error: Could not fetch renderer info. Is your' +
            ' machine equipped with a discrete GPU?';
        return true;
    }
    return false;
}

/**
 * This function needs to run after the first frame has been rendered since we
 * are uploading to textures which only become valid after the first frame has
 * been rendered.
 * @param {string} dirUrl Either points to a directory that contains scene files
 *                        or to a json file that maps virtual filenames to
 *                        download links
 * @param {!FilenameToLinkTranslator} filenameToLinkTranslator
 * @param {boolean} useSparseGrid Whether to use the sparse 3D grid
 * @param {!object} sceneParams Holds basic information about the scene like grid
 *                             dimensions
 **/
function loadOnFirstFrame(
    dirUrl, filenameToLinkTranslator, useSparseGrid, sceneParams) {
    if (gLoadOnFirstFrameRan) return;

    // Early out if the renderer is not supported.
    if (isRendererUnsupported()) {
        gLoadOnFirstFrameRan = true;
        let loadingContainer = document.getElementById('loading-container');
        loadingContainer.style.display = 'none';
        return;
    }

    if (useSparseGrid) {
        // The 3D textures already have been allocated in loadScene. Here we fill
        // them with data slice-by-slice (overlapping download and texture upload).
        function _getUniform(uniformName) {
            return gRayMarchScene.children[0].material.uniforms[uniformName]['value'];
        }

        const sparseGridDensityTexture = _getUniform('sparseGridDensity');
        const sparseGridRgbTexture = _getUniform('sparseGridRgb');
        const sparseGridFeaturesTexture = _getUniform('sparseGridFeatures');

        function _loadVolumeTextureSliceBySlice(uploadFn, filenamePrefix) {
            return loadVolumeTextureSliceBySlice(
                uploadFn, sceneParams['num_slices'], sceneParams['slice_depth'],
                sceneParams['atlas_width'], sceneParams['atlas_height'],
                sceneParams['atlas_depth'], filenamePrefix, filenameToLinkTranslator);
        }

        let uploadFn = (rgbaImage, sliceIndex, volumeWidth, volumeHeight, sliceDepth) => {
            // The png's RGB channels hold RGB, and the png's alpha channel holds
            // density. We split apart RGB and density and upload to two distinct
            // textures, so we can separate query these quantities.
            let rgbPixels = new Uint8Array(volumeWidth * volumeHeight * sliceDepth * 3);
            let densityPixels = new Uint8Array(volumeWidth * volumeHeight * sliceDepth * 1);
            for (let j = 0; j < volumeWidth * volumeHeight * sliceDepth; j++) {
                rgbPixels[j * 3 + 0] = rgbaImage[j * 4 + 0];
                rgbPixels[j * 3 + 1] = rgbaImage[j * 4 + 1];
                rgbPixels[j * 3 + 2] = rgbaImage[j * 4 + 2];
                densityPixels[j] = rgbaImage[j * 4 + 3];
            }
            uploadVolumeSlice(
                rgbPixels, sparseGridRgbTexture, sliceIndex, volumeWidth,
                volumeHeight, sliceDepth);
            uploadVolumeSlice(
                densityPixels, sparseGridDensityTexture, sliceIndex, volumeWidth,
                volumeHeight, sliceDepth);
        };
        let rgbAndsparseGridDensityTexturePromise =
            _loadVolumeTextureSliceBySlice(uploadFn, 'sparse_grid_rgb_and_density');

        // The pngs RGBA channels are directly interpreted as four feature channels.
        uploadFn =
            (rgbaImage, sliceIndex, volumeWidth, volumeHeight, sliceDepth) => {
                uploadVolumeSlice(
                    rgbaImage, sparseGridFeaturesTexture, sliceIndex, volumeWidth,
                    volumeHeight, sliceDepth);
            };
        sparseGridFeaturesTexturePromise =
            _loadVolumeTextureSliceBySlice(uploadFn, 'sparse_grid_features');

        let allTexturesPromise = Promise.all([
            rgbAndsparseGridDensityTexturePromise, sparseGridFeaturesTexturePromise
        ]);
        allTexturesPromise.catch(errors => {
            console.error(
                'Could not load scene from: ' + dirUrl + ', errors:\n\t' + errors[0] +
                '\n\t' + errors[1] + '\n\t' + errors[2] + '\n\t' + errors[3]);
        });

        allTexturesPromise.then(texture => {
            hideLoading();
            console.log('Successfully loaded scene from: ' + dirUrl);
        });
    } else {
        hideLoading();
    }
    gLoadOnFirstFrameRan = true;
}



/**
 * The main update function that gets called every frame.
 * @param {number} t elapsed time between frames
 * @param {string} dirUrl Either points to a directory that contains scene files
 *                        or to a json file that maps virtual filenames to
 *                        download links
 * @param {!FilenameToLinkTranslator} filenameToLinkTranslator
 * @param {boolean} useSparseGrid Whether to use the sparse 3D grid
 * @param {!object} sceneParams Holds basic information about the scene like grid
 *                             dimensions
 */
function update(
    t, dirUrl, filenameToLinkTranslator, useSparseGrid, sceneParams, cas_num) {
    loadOnFirstFrame(
        dirUrl, filenameToLinkTranslator, useSparseGrid, sceneParams);
    updateCameraControls();

    renderProgressively(cas_num);



    gStats.update();
    // updateFPSCounter();
    requestAnimationFrame(
        t => update(
            t, dirUrl, filenameToLinkTranslator, useSparseGrid, sceneParams));
}


/**
 * Starts the volumetric scene viewer application.
 */
function start() {
    initFromParameters();
    addHandlers();
}

window.onload = start;