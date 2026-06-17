import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { HeightGrid } from './HeightSampler';

/**
 * Custom 3D terrain preview (not one of the map engines). Renders a heightmap grid —
 * the clipped selection region — as a Three.js mesh with orbit controls. The mesh is
 * built purely from the supplied grid, so its detail is the grid resolution, fully
 * independent of any map's zoom.
 */
export class TerrainPreview {
    private container: HTMLElement;
    private renderer: THREE.WebGLRenderer;
    private scene: THREE.Scene;
    private camera: THREE.PerspectiveCamera;
    private controls: OrbitControls;
    private mesh: THREE.Mesh | null = null;
    private raf = 0;

    // Normalize the largest horizontal extent to this many world units, so the camera
    // framing is consistent regardless of the real-world size of the selection.
    private static readonly TARGET_SIZE = 100;

    constructor(container: HTMLElement) {
        this.container = container;

        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setPixelRatio(window.devicePixelRatio);
        container.appendChild(this.renderer.domElement);

        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x0b1021);

        this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1_000_000);

        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = false;          // no inertia/acceleration
        this.controls.screenSpacePanning = false;     // pan along the ground, map-like
        // Match the 3D maps: left drag = pan, right drag = rotate.
        this.controls.mouseButtons = {
            LEFT: THREE.MOUSE.PAN,
            MIDDLE: THREE.MOUSE.DOLLY,
            RIGHT: THREE.MOUSE.ROTATE,
        };

        this.scene.add(new THREE.AmbientLight(0xffffff, 0.7));
        const sun = new THREE.DirectionalLight(0xfff6e8, 1.4);
        sun.position.set(1, 2, 1.5);
        this.scene.add(sun);

        this.resize();
        const loop = () => {
            this.raf = requestAnimationFrame(loop);
            this.controls.update();
            this.renderer.render(this.scene, this.camera);
        };
        loop();
    }

    /** Build (or rebuild) the terrain mesh from a height grid. */
    setHeightGrid(grid: HeightGrid, exaggeration = 1): void {
        this.disposeMesh();

        const { heights, cols, rows, widthMeters, heightMeters } = grid;
        const scale = TerrainPreview.TARGET_SIZE / Math.max(widthMeters, heightMeters);

        // PlaneGeometry lays out vertices bottom-to-top (iy=0 is the bottom row), while
        // our height grid is top-to-bottom (row 0 = north edge), so flip the row index.
        const geo = new THREE.PlaneGeometry(widthMeters * scale, heightMeters * scale, cols - 1, rows - 1);
        const pos = geo.attributes.position;
        const zScale = scale * exaggeration;
        for (let iy = 0; iy < rows; iy++) {
            for (let ix = 0; ix < cols; ix++) {
                const vi = iy * cols + ix;
                const hi = (rows - 1 - iy) * cols + ix;
                pos.setZ(vi, heights[hi] * zScale);
            }
        }
        pos.needsUpdate = true;
        geo.computeVertexNormals();

        const material = new THREE.MeshStandardMaterial({ color: 0xc9c3b2, side: THREE.DoubleSide });
        const mesh = new THREE.Mesh(geo, material);
        mesh.rotation.x = -Math.PI / 2; // lay the XY plane flat, heights become +Y (up)
        this.scene.add(mesh);
        this.mesh = mesh;

        this.frameCamera(widthMeters * scale, heightMeters * scale);
    }

    clear(): void {
        this.disposeMesh();
    }

    resize(): void {
        const w = this.container.clientWidth || 1;
        const h = this.container.clientHeight || 1;
        this.renderer.setSize(w, h, false);
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
    }

    dispose(): void {
        cancelAnimationFrame(this.raf);
        this.disposeMesh();
        this.controls.dispose();
        this.renderer.dispose();
        this.renderer.domElement.remove();
    }

    private frameCamera(w: number, h: number): void {
        const d = Math.max(w, h);
        this.camera.position.set(0, d * 0.85, d * 0.95);
        this.camera.lookAt(0, 0, 0);
        this.controls.target.set(0, 0, 0);
        this.controls.update();
    }

    private disposeMesh(): void {
        if (!this.mesh) return;
        this.scene.remove(this.mesh);
        this.mesh.geometry.dispose();
        (this.mesh.material as THREE.Material).dispose();
        this.mesh = null;
    }
}
