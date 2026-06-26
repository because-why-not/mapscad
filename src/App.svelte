<script>
    import MapPanel from './MapPanel.svelte';
    import PreviewPanel from './PreviewPanel.svelte';

    let {
        // Map menu data + callbacks (forwarded to MapPanel)
        tileProviders = [],
        customMaps = [],
        initialActiveProviderId = '',
        initialSunDate = new Date(),
        initialShadows = true,
        onLayerSwitch = () => {},
        onSunChange = () => {},
        onShadowsChange = () => {},
        onSelectToggle = () => {},
        onAspectChange = () => {},
        initialMapZoom = 0,
        // 3D-view menu (forwarded to PreviewPanel)
        previewDems = [],
        initialPreviewDemId = '',
        previewZoomMin = 0,
        previewZoomMax = 17,
        initialPreviewSettings = {},
        onPreviewDemChange = () => {},
        onPreviewSettingsChange = () => {},
        onPreviewGenerate = () => {},
        onPreviewSave = () => {},
        onPreviewResetCamera = () => {},
        onPreviewShareLink = () => '',
        onPreviewCancel = () => {},
        // Fired whenever the split layout changes, so index.ts can resize the renderers.
        onLayoutChange = () => {},
    } = $props();

    let mapPanel;
    let previewPanel;
    let containerEl;

    let orientation = $state(getOrientation());
    let previewVisible = $state(false);
    let collapsed = $state('none');     // 'none' | 'map' | 'preview'
    let ratio = $state(loadRatio());    // map-panel fraction when both are shown

    let showBoth = $derived(previewVisible && collapsed === 'none');
    let mapShown = $derived(collapsed !== 'map');
    let previewShown = $derived(previewVisible && collapsed !== 'preview');

    let mapStyle = $derived(panelStyle('map'));
    let previewStyle = $derived(panelStyle('preview'));

    function getOrientation() {
        return window.innerWidth >= window.innerHeight ? 'vertical' : 'horizontal';
    }
    function loadRatio() {
        const v = parseFloat(localStorage.getItem('splitRatio') || '');
        return v > 0.1 && v < 0.9 ? v : 0.5;
    }

    // --- exports used by index.ts ---
    export function getMapMount() { return mapPanel?.getMount(); }
    export function getPreviewMount() { return previewPanel?.getMount(); }
    export function setActiveProvider(id) { mapPanel?.setActiveProvider(id); }
    export function setTileProviders(p) { mapPanel?.setTileProviders(p); }
    export function setCustomMaps(m) { mapPanel?.setCustomMaps(m); }
    export function setSelectActive(active) { mapPanel?.setSelectActive(active); }
    export function setSelectTool(tool) { mapPanel?.setSelectTool(tool); }
    export function setMapZoom(z) { mapPanel?.setZoom(z); }
    export function setPreviewStats(stats) { previewPanel?.setPreviewStats(stats); }
    export function setPreviewLoading(state) { previewPanel?.setPreviewLoading(state); }
    export function setPreviewZoomRange(min, max, heightZoom) { previewPanel?.setZoomRange(min, max, heightZoom); }
    export function setPreviewVisible(visible) {
        previewVisible = visible;
        if (!visible) collapsed = 'none';
        notifyLayout();
    }

    function notifyLayout() {
        requestAnimationFrame(() => onLayoutChange());
    }

    function panelStyle(which) {
        if (which === 'map') {
            if (!mapShown) return 'display:none';
            if (showBoth) return `flex:0 0 ${(ratio * 100).toFixed(2)}%`;
            return 'flex:1 1 100%';
        }
        if (!previewShown) return 'display:none';
        if (showBoth) return 'flex:1 1 0';
        return 'flex:1 1 100%';
    }

    function collapseMap() { collapsed = 'map'; notifyLayout(); }
    function collapsePreview() { collapsed = 'preview'; notifyLayout(); }
    function restore() { collapsed = 'none'; notifyLayout(); }

    function startDrag(e) {
        e.preventDefault();
        const rect = containerEl.getBoundingClientRect();
        const move = ev => {
            const r = orientation === 'vertical'
                ? (ev.clientX - rect.left) / rect.width
                : (ev.clientY - rect.top) / rect.height;
            ratio = Math.min(0.9, Math.max(0.1, r));
            onLayoutChange();
        };
        const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            try { localStorage.setItem('splitRatio', String(ratio)); } catch { /* ignore */ }
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
    }

    $effect(() => {
        const onResize = () => { orientation = getOrientation(); onLayoutChange(); };
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    });
</script>

<div class="split {orientation}" bind:this={containerEl}>
    <MapPanel
        bind:this={mapPanel}
        style={mapStyle}
        {tileProviders}
        {customMaps}
        {initialActiveProviderId}
        {initialSunDate}
        {initialShadows}
        {onLayerSwitch}
        {onSunChange}
        {onShadowsChange}
        {onSelectToggle}
        {onAspectChange}
        {initialMapZoom}
        canCollapse={showBoth}
        onCollapse={collapseMap}
    />

    {#if showBoth}
        <div
            class="gutter"
            role="separator"
            aria-orientation={orientation === 'vertical' ? 'vertical' : 'horizontal'}
            aria-label="Resize panels"
            onpointerdown={startDrag}
        ></div>
    {/if}

    <PreviewPanel
        bind:this={previewPanel}
        style={previewStyle}
        canCollapse={showBoth}
        onCollapse={collapsePreview}
        dems={previewDems}
        initialDemId={initialPreviewDemId}
        onDemChange={onPreviewDemChange}
        zoomMin={previewZoomMin}
        zoomMax={previewZoomMax}
        initialSettings={initialPreviewSettings}
        onSettingsChange={onPreviewSettingsChange}
        onGenerate={onPreviewGenerate}
        onSave={onPreviewSave}
        onResetCamera={onPreviewResetCamera}
        onShareLink={onPreviewShareLink}
        onCancel={onPreviewCancel}
    />

    {#if collapsed !== 'none'}
        <button class="restore-tab btn btn-xs bg-base-100 border-0 shadow restore-{collapsed}-{orientation}" title="Restore panel" onclick={restore}>⟺</button>
    {/if}
</div>
