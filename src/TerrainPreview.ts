import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { ModelGeometry } from './MapModel';

/**
 * Custom 3D terrain preview (not one of the map engines). It is a pure consumer of the
 * MapModel's neutral geometry: feed it a ModelGeometry (metre-space vertices + indices,
 * one solid per tile) and it renders it. All surface/socket/tile/exaggeration decisions
 * live in MapModel, so the preview and the exported STL show the identical solid.
 */
export class TerrainPreview {
    private container: HTMLElement;
    private renderer: THREE.WebGLRenderer;
    private scene: THREE.Scene;
    private camera: THREE.PerspectiveCamera;
    private controls: OrbitControls;
    private group: THREE.Group;
    private material: THREE.MeshStandardMaterial;
    private framed = false; // only auto-frame the first model after the view was empty
    private raf = 0;

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

        // FrontSide (the default) culls back faces. Relies on MapModel emitting outward
        // winding — top surface +Y, socket walls/base oriented away from the model.
        this.material = new THREE.MeshStandardMaterial({ color: 0xc9c3b2, side: THREE.FrontSide });
        this.group = new THREE.Group();
        this.scene.add(this.group);

        this.resize();
        const loop = () => {
            this.raf = requestAnimationFrame(loop);
            this.controls.update();
            this.renderer.render(this.scene, this.camera);
        };
        loop();
    }

    /** Render a MapModel geometry (or null to clear). One Three mesh per tile. */
    setGeometry(geo: ModelGeometry | null): void {
        this.clear();
        if (!geo || geo.tiles.length === 0) {
            this.framed = false; // next model after an empty view gets re-framed
            return;
        }

        for (const tile of geo.tiles) {
            const buf = new THREE.BufferGeometry();
            buf.setAttribute('position', new THREE.BufferAttribute(tile.positions, 3));
            buf.setIndex(new THREE.BufferAttribute(tile.indices, 1));
            buf.computeVertexNormals();
            const mesh = new THREE.Mesh(buf, this.material);
            this.group.add(mesh);
        }

        // Frame only the first model after the view was empty; leave the user's camera
        // alone on rebuilds (e.g. tweaking height scale, socket, tiles).
        if (!this.framed) {
            this.frameCamera(geo.widthMeters, geo.heightMeters);
            this.framed = true;
        }
    }

    clear(): void {
        for (const child of this.group.children) {
            (child as THREE.Mesh).geometry.dispose();
        }
        this.group.clear();
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
        this.clear();
        this.material.dispose();
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
}
