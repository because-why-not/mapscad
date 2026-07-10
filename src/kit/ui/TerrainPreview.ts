import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { ModelGeometry } from '../MapModel';
import type { PreviewConfig } from './PreviewConfig';
import { OSM_FEATURES } from '../mapelements/osmFeatures';

// Separated OSM bodies are tinted their feature colour so the multi-object (multi-colour print)
// split is obvious in the preview; keyed by body `kind` (the feature id). Reuses the same colours
// the 2D overlay uses, so map, preview and 3MF agree.
const KIND_COLORS: Record<string, string> = Object.fromEntries(
    OSM_FEATURES.map(f => [f.id, f.strokeColor]),
);

/**
 * Custom 3D terrain preview (not one of the map engines). It is a pure consumer of the
 * MapModel's neutral geometry: feed it a ModelGeometry (metre-space vertices + indices,
 * one solid per body) and it renders it. All surface/socket/tile/exaggeration decisions
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
    // Per-kind recoloured clones of `material` for separated OSM bodies, created lazily and cached
    // (one per feature kind, reused across rebuilds). Disposed with the preview, not per rebuild.
    private kindMaterials = new Map<string, THREE.MeshStandardMaterial>();
    private socketLineMaterial: THREE.LineBasicMaterial;
    private framed = false; // only auto-frame the first model after the view was empty
    private lastW = 0;       // extent of the current model, for the reset-camera button
    private lastH = 0;
    private lastCY = 0;      // vertical centre of the model (real elevation), for framing
    private raf = 0;         // pending render-frame handle (0 = nothing scheduled)

    // Custom right-drag rotation that orbits around the point under the cursor.
    private raycaster = new THREE.Raycaster();
    private pointer = new THREE.Vector2();
    private pivot = new THREE.Vector3();
    private pickPlane = new THREE.Plane(); // horizontal pivot plane at the model's mid-elevation
    private lastX = 0;
    private lastY = 0;

    private static readonly ROT_SPEED = 0.005; // radians per pixel
    private static readonly MIN_POLAR = 0.12;  // keep the camera off the poles / below ground
    private static readonly MAX_POLAR = 1.52;

    constructor(container: HTMLElement, config?: PreviewConfig) {
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
        // Damping is off, so OrbitControls fires 'change' synchronously on every camera move
        // (pan/zoom + our custom right-drag, which ends in controls.update()). That's our only
        // camera redraw trigger — the scene has no animation, so there's no per-frame loop.
        this.controls.addEventListener('change', this.requestRender);
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
        // Outline marking where the socket begins (the lowest surface level).
        this.socketLineMaterial = new THREE.LineBasicMaterial({ color: 0xff7043 });
        this.group = new THREE.Group();
        this.scene.add(this.group);

        // Apply the persisted render flags (the viewer owns HOW a flag renders; the config is
        // just the values). Without a config the built-in defaults apply.
        if (config) this.setSmoothShading(config.get().smoothShading);

        this.resize();
        this.requestRender(); // initial paint of the (empty) scene
    }

    /** Schedule a single render on the next frame, coalescing multiple requests in the same tick.
     *  The preview has no animation, so we redraw only when the model or the camera changes. */
    private requestRender = (): void => {
        if (this.raf) return;
        this.raf = requestAnimationFrame(this.renderFrame);
    };
    private renderFrame = (): void => {
        this.raf = 0;
        this.controls.update();
        this.renderer.render(this.scene, this.camera);
    };

    /** Render a MapModel geometry (or null to clear). One Three mesh per body. */
    setGeometry(geo: ModelGeometry | null): void {
        this.clear();
        this.requestRender(); // content changed (cleared or rebuilt) — redraw regardless of the camera
        if (!geo || geo.bodies.length === 0) {
            this.framed = false; // next model after an empty view gets re-framed
            return;
        }

        this.lastW = geo.widthMeters;
        this.lastH = geo.heightMeters;
        // Y is real elevation (not centred on 0), so frame around the model's vertical midpoint.
        this.lastCY = (geo.minY + geo.maxY) / 2;

        for (const body of geo.bodies) {
            const buf = new THREE.BufferGeometry();
            buf.setAttribute('position', new THREE.BufferAttribute(body.positions, 3));
            buf.setIndex(new THREE.BufferAttribute(body.indices, 1));
            buf.computeVertexNormals();
            const mesh = new THREE.Mesh(buf, this.materialForKind(body.kind));
            this.group.add(mesh);
        }

        // A rectangle at the socket-start level traces the model footprint, sitting on the
        // socket's side walls so it reads as "terrain above, socket below".
        if (geo.socketStartY != null) {
            const y = geo.socketStartY;
            const hw = geo.widthMeters / 2, hh = geo.heightMeters / 2;
            const corners = [
                new THREE.Vector3(-hw, y, -hh),
                new THREE.Vector3(hw, y, -hh),
                new THREE.Vector3(hw, y, hh),
                new THREE.Vector3(-hw, y, hh),
            ];
            const buf = new THREE.BufferGeometry().setFromPoints(corners);
            const line = new THREE.LineLoop(buf, this.socketLineMaterial);
            this.group.add(line);
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

    /** The material for a body: the base terrain material, or a cached recoloured clone for a
     *  separated OSM feature (terrain / unknown kinds keep the base material). */
    private materialForKind(kind: string | undefined): THREE.MeshStandardMaterial {
        const color = kind ? KIND_COLORS[kind] : undefined;
        if (!color) return this.material;
        let mat = this.kindMaterials.get(kind!);
        if (!mat) {
            mat = this.material.clone();
            mat.color.set(color);
            this.kindMaterials.set(kind!, mat);
        }
        return mat;
    }

    /** Re-frame the camera to the default south-looking view of the current model. */
    resetCamera(): void {
        if (this.lastW > 0 || this.lastH > 0) this.frameCamera(this.lastW, this.lastH);
    }

    /** Preview-only: smooth (interpolated vertex normals) vs flat (per-face) shading. */
    setSmoothShading(enabled: boolean): void {
        this.material.flatShading = !enabled;
        this.material.needsUpdate = true;
        for (const mat of this.kindMaterials.values()) {
            mat.flatShading = !enabled;
            mat.needsUpdate = true;
        }
        this.requestRender();
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

    /** Point under the cursor on the model's mid-elevation plane, or null (ray parallel).
     *  We intersect a flat plane instead of the mesh: the terrain is rebuilt constantly and a
     *  per-triangle raycast over the whole solid blocks the main thread for hundreds of ms. */
    private pickPoint(e: PointerEvent): THREE.Vector3 | null {
        const rect = this.renderer.domElement.getBoundingClientRect();
        this.pointer.set(
            ((e.clientX - rect.left) / rect.width) * 2 - 1,
            -((e.clientY - rect.top) / rect.height) * 2 + 1,
        );
        this.raycaster.setFromCamera(this.pointer, this.camera);
        this.pickPlane.set(new THREE.Vector3(0, 1, 0), -this.lastCY);
        const hit = new THREE.Vector3();
        return this.raycaster.ray.intersectPlane(this.pickPlane, hit) ? hit : null;
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
        this.requestRender();
    }

    dispose(): void {
        cancelAnimationFrame(this.raf);
        this.controls.removeEventListener('change', this.requestRender);
        const el = this.renderer.domElement;
        el.removeEventListener('pointerdown', this.onPointerDown);
        el.removeEventListener('contextmenu', this.onContextMenu);
        window.removeEventListener('pointermove', this.onPointerMove);
        window.removeEventListener('pointerup', this.onPointerUp);
        this.clear();
        this.material.dispose();
        for (const mat of this.kindMaterials.values()) mat.dispose();
        this.socketLineMaterial.dispose();
        this.controls.dispose();
        this.renderer.dispose();
        el.remove();
    }

    private frameCamera(w: number, h: number): void {
        const d = Math.max(w, h);
        const cy = this.lastCY; // model sits at real elevation; aim at its vertical centre
        this.camera.position.set(0, cy + d * 0.85, d * 0.95);
        this.camera.lookAt(0, cy, 0);
        this.controls.target.set(0, cy, 0);
        this.controls.update();
    }
}
