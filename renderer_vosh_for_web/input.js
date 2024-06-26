/**
 * @fileoverview Input event handling.
 */

// With PointerLockControls we have to track key states ourselves.
/** @type {boolean} */
let gKeyW = false;
/** @type {boolean} */
let gKeyA = false;
/** @type {boolean} */
let gKeyS = false;
/** @type {boolean} */
let gKeyD = false;
/** @type {boolean} */
let gKeyQ = false;
/** @type {boolean} */
let gKeyE = false;
/** @type {boolean} */
let gKeyShift = false;

/**
 * Keeps track of frame times for smooth camera motion.
 * @type {!THREE.Clock}
 */
const gClock = new THREE.Clock();

/**
 * Adds event listeners to UI.
 */
function addHandlers() {
    document.addEventListener('keypress', function (e) {
        if (e.keyCode === 32 || e.key === ' ' || e.key === 'Spacebar') {
            // if (gDisplayMode == DisplayModeType.DISPLAY_NORMAL) {
            //     gDisplayMode = DisplayModeType.DISPLAY_DIFFUSE;
            // } else if (gDisplayMode == DisplayModeType.DISPLAY_DIFFUSE) {
            //     gDisplayMode = DisplayModeType.DISPLAY_FEATURES;
            // } else if (gDisplayMode == DisplayModeType.DISPLAY_FEATURES) {
            //     gDisplayMode = DisplayModeType.DISPLAY_VIEW_DEPENDENT;
            // } else if (gDisplayMode == DisplayModeType.DISPLAY_VIEW_DEPENDENT) {
            //     gDisplayMode = DisplayModeType.DISPLAY_COARSE_GRID;
            // } else if (gDisplayMode == DisplayModeType.DISPLAY_COARSE_GRID){
            //     gDisplayMode = DisplayModeType.DISPLAY_MESH;
            // } else if (gDisplayMode == DisplayModeType.DISPLAY_MESH){
            //     gDisplayMode = DisplayModeType.DISPLAY_VOLUME;
            // } else if (gDisplayMode == DisplayModeType.DISPLAY_VOLUME){
            //     gDisplayMode = DisplayModeType.DISPLAY_MESH_AND_GRID;
            // } 
            // else /* gDisplayModeType == DisplayModeType.DISPLAY_COARSE_GRID */ {
            //     gDisplayMode = DisplayModeType.DISPLAY_NORMAL;
            // }
            
            // if (gDisplayMode == DisplayModeType.DISPLAY_NORMAL) {
            //     console.log("DISPLAY_NORMAL");
            // } else if (gDisplayMode == DisplayModeType.DISPLAY_DIFFUSE) {
            //     console.log("DISPLAY_DIFFUSE");
            // } else if (gDisplayMode == DisplayModeType.DISPLAY_FEATURES) {
            //     console.log("DISPLAY_FEATURES");
            // } else if (gDisplayMode == DisplayModeType.DISPLAY_VIEW_DEPENDENT) {
            //     console.log("DISPLAY_VIEW_DEPENDENT");
            // } else if (gDisplayMode == DisplayModeType.DISPLAY_COARSE_GRID){
            //     console.log("DISPLAY_COARSE_GRID");
            // } else if (gDisplayMode == DisplayModeType.DISPLAY_MESH){
            //     console.log("DISPLAY_MESH");
            // } else if (gDisplayMode == DisplayModeType.DISPLAY_VOLUME){
            //     console.log("DISPLAY_VOLUME");
            // } 
            // else if(gDisplayMode == DisplayModeType.DISPLAY_MESH_AND_GRID){
            //     console.log("DISPLAY_MESH_AND_GRID");
            // }

            // e.preventDefault();
        }
        if (e.key === 'i') {
            gStepMult += 1;
            console.log('num samples per voxel:', gStepMult);
            e.preventDefault();
        }
        if (e.key === 'o') {
            gStepMult -= 1;
            console.log('num samples per voxel:', gStepMult);
            e.preventDefault();
        }
        if (e.key === 'r'){
            gOrbitControls.autoRotate = ! gOrbitControls.autoRotate;
            e.preventDefault();
        }
    });
    document.addEventListener('keydown', function (e) {
        let key = e.key.toLowerCase();
        if (key === 'w') {
            gKeyW = true;
            e.preventDefault();
        }
        if (key === 'a') {
            gKeyA = true;
        }
        if (key === 's') {
            gKeyS = true;
            e.preventDefault();
        }
        if (key === 'd') {
            gKeyD = true;
            e.preventDefault();
        }
        if (key === 'q') {
            gKeyQ = true;
            e.preventDefault();
        }
        if (key === 'e') {
            gKeyE = true;
            e.preventDefault();
        }
        if (e.key === 'Shift') {
            gKeyShift = true;
            e.preventDefault();
        }
    });
    document.addEventListener('keyup', function (e) {
        let key = e.key.toLowerCase();
        if (key === 'w') {
            gKeyW = false;
            e.preventDefault();
        }
        if (key === 'a') {
            gKeyA = false;
        }
        if (key === 's') {
            gKeyS = false;
            e.preventDefault();
        }
        if (key === 'd') {
            gKeyD = false;
            e.preventDefault();
        }
        if (key === 'q') {
            gKeyQ = false;
            e.preventDefault();
        }
        if (key === 'e') {
            gKeyE = false;
            e.preventDefault();
        }
        if (e.key === 'Shift') {
            gKeyShift = false;
            e.preventDefault();
        }
    });
}

/**
 * Sets up the camera controls.
 */
function setupCameraControls(mouseMode, view) {
    //console.log("mouseMode:" + mouseMode);
    if (mouseMode && mouseMode == 'fps') {
        gPointerLockControls = new THREE.PointerLockControls(gCamera, view);
        let startButton = document.createElement('button');
        startButton.innerHTML = 'Click to enable mouse navigation';
        startButton.style = 'position: absolute;' +
            'top: 0;' +
            'width: 250px;' +
            'margin: 0 0 0 -125px;';
        viewSpaceContainer.appendChild(startButton);
        startButton.addEventListener('click', function () {
            gPointerLockControls.lock();
            gPointerLockControls.connect();
        }, false);
    } else {
        gOrbitControls = new THREE.OrbitControls(gCamera, view);
        // Disable damping until we have temporal reprojection for upscaling.
        // gOrbitControls.enableDamping = true;
        gOrbitControls.autoRotate = false;
        gOrbitControls.screenSpacePanning = true;
        gOrbitControls.zoomSpeed = 0.5;
        gOrbitControls.autoRotateSpeed = -6;
        gOrbitControls.enableDamping = true;
        gOrbitControls.dampingFactor = 0.3;
    }
}

/**
 * Updates the camera based on user input.
 */
function updateCameraControls() {
    if (gOrbitControls) {
        gOrbitControls.update();
    } else {
        const elapsed = gClock.getDelta();
        let movementSpeed = 0.25;
        if (gKeyShift) {
            movementSpeed = 1;
        }
        let camForward = gCamera.getWorldDirection(new THREE.Vector3(0., 0., 0.));
        let upVec = new THREE.Vector3(0., 1., 0.);
        if (gKeyW) {
            // gPointerLockControls.moveForward undesirably restricts movement to the
            // X-Z-plane
            gCamera.position =
                gCamera.position.addScaledVector(camForward, elapsed * movementSpeed);
        }
        if (gKeyA) {
            gPointerLockControls.moveRight(-elapsed * movementSpeed);
        }
        if (gKeyS) {
            gCamera.position = gCamera.position.addScaledVector(
                camForward, -elapsed * movementSpeed);
        }
        if (gKeyD) {
            gPointerLockControls.moveRight(elapsed * movementSpeed);
        }
        if (gKeyQ) {
            gCamera.position =
                gCamera.position.addScaledVector(upVec, -elapsed * movementSpeed);
        }
        if (gKeyE) {
            gCamera.position =
                gCamera.position.addScaledVector(upVec, elapsed * movementSpeed);
        }
    }
    gCamera.updateProjectionMatrix();
    gCamera.updateMatrixWorld();
}