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
    private lastW = 0;       // extent of the current model, for the reset-camera button
    private lastH = 0;
    private raf = 0;

    // Custom right-drag rotation that orbits around the point under the cursor.
    private raycaster = new THREE.Raycaster();
    private pointer = new THREE.Vector2();
    private pivot = new THREE.Vector3();
    private lastX = 0;
    private lastY = 0;

    private static readonly ROT_SPEED = 0.005; // radians per pixel
    private static readonly MIN_POLAR = 0.12;  // keep the camera off the poles / below ground
    private static readonly MAX_POLAR = 1.52;

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
        // Left drag = pan, wheel/middle = zoom. Right drag is handled by us below so it
        // can orbit around the terrain under the cursor instead of OrbitControls' target.
        this.controls.mouseButtons = {
            LEFT: THREE.MOUSE.PAN,
            MIDDLE: THREE.MOUSE.DOLLY,
            RIGHT: undefined,
        } as any;
        const el = this.renderer.domElement;
        el.addEventListener('pointerdown', this.onPointerDown);
        el.addEventListener('contextmenu', this.onContextMenu);

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

        this.lastW = geo.widthMeters;
        this.lastH = geo.heightMeters;

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

    /** Re-frame the camera to the default south-looking view of the current model. */
    resetCamera(): void {
        if (this.lastW > 0 || this.lastH > 0) this.frameCamera(this.lastW, this.lastH);
    }

    /** Preview-only: smooth (interpolated vertex normals) vs flat (per-face) shading. */
    setSmoothShading(enabled: boolean): void {
        this.material.flatShading = !enabled;
        this.material.needsUpdate = true;
    }

    // --- right-drag rotation around the cursor --------------------------------

    private onContextMenu = (e: Event): void => e.preventDefault();

    private onPointerDown = (e: PointerEvent): void => {
        if (e.button !== 2) return; // right button only
        e.preventDefault();
        // Pivot = the terrain point under the cursor at drag start (fall back to target).
        const hit = this.pickPoint(e);
        this.pivot.copy(hit ?? this.controls.target);
        this.lastX = e.clientX;
        this.lastY = e.clientY;
        window.addEventListener('pointermove', this.onPointerMove);
        window.addEventListener('pointerup', this.onPointerUp);
    };

    private onPointerMove = (e: PointerEvent): void => {
        const dx = e.clientX - this.lastX;
        const dy = e.clientY - this.lastY;
        this.lastX = e.clientX;
        this.lastY = e.clientY;
        this.rotateAroundPivot(dx, dy);
    };

    private onPointerUp = (): void => {
        window.removeEventListener('pointermove', this.onPointerMove);
        window.removeEventListener('pointerup', this.onPointerUp);
    };

    /** World-space point of the front-most mesh under the cursor, or null. */
    private pickPoint(e: PointerEvent): THREE.Vector3 | null {
        const rect = this.renderer.domElement.getBoundingClientRect();
        this.pointer.set(
            ((e.clientX - rect.left) / rect.width) * 2 - 1,
            -((e.clientY - rect.top) / rect.height) * 2 + 1,
        );
        this.raycaster.setFromCamera(this.pointer, this.camera);
        const hits = this.raycaster.intersectObjects(this.group.children, false);
        return hits.length ? hits[0].point.clone() : null;
    }

    /** Orbit camera and target rigidly around the pivot, preserving the view offset. */
    private rotateAroundPivot(dx: number, dy: number): void {
        this.camera.updateMatrixWorld();
        const up = new THREE.Vector3(0, 1, 0);
        const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0).normalize();
        const yaw = new THREE.Quaternion().setFromAxisAngle(up, -dx * TerrainPreview.ROT_SPEED);
        const pitch = new THREE.Quaternion().setFromAxisAngle(right, -dy * TerrainPreview.ROT_SPEED);
        const full = yaw.clone().multiply(pitch);

        // Reject pitch that would push the camera past the poles / under the ground.
        const camOff = this.camera.position.clone().sub(this.pivot);
        const candidate = camOff.clone().applyQuaternion(full);
        const polar = Math.acos(THREE.MathUtils.clamp(candidate.y / candidate.length(), -1, 1));
        const q = polar > TerrainPreview.MIN_POLAR && polar < TerrainPreview.MAX_POLAR ? full : yaw;

        const tarOff = this.controls.target.clone().sub(this.pivot);
        this.camera.position.copy(this.pivot).add(camOff.applyQuaternion(q));
        this.controls.target.copy(this.pivot).add(tarOff.applyQuaternion(q));
        this.controls.update();
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
        const el = this.renderer.domElement;
        el.removeEventListener('pointerdown', this.onPointerDown);
        el.removeEventListener('contextmenu', this.onContextMenu);
        window.removeEventListener('pointermove', this.onPointerMove);
        window.removeEventListener('pointerup', this.onPointerUp);
        this.clear();
        this.material.dispose();
        this.controls.dispose();
        this.renderer.dispose();
        el.remove();
    }

    private frameCamera(w: number, h: number): void {
        const d = Math.max(w, h);
        this.camera.position.set(0, d * 0.85, d * 0.95);
        this.camera.lookAt(0, 0, 0);
        this.controls.target.set(0, 0, 0);
        this.controls.update();
    }
}
