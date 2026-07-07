<script>
    import { setContext, untrack } from 'svelte';
    import MapPanel from './MapPanel.svelte';
    import PreviewPanel from './PreviewPanel.svelte';
    import { SESSION_DATA } from './sessionData';
    import { SessionStore } from './sessionStore.svelte';
    import { KIT } from './kitContext';

    // The App owns the split LAYOUT only: two panels, the drag gutter, collapse/restore. Everything
    // else lives in the panels (menus) and the kit (behavior). It provides two contexts: KIT (the
    // kit objects — panels call methods + subscribe to events directly) and SESSION_DATA (the shared
    // element-list store below).
    let {
        // The kit objects (session/config always set; the two viewers are filled in by index.ts
        // right after mount — see kitContext.ts for the timing rules).
        kit,
        // Static menu data, shaped by index.ts from the manifest.
        tileProviders = [],
        customMaps = [],
        initialActiveProviderId = '',
        initialMapZoom = 0,
        features = [],
        previewDems = [],
        initialPreviewDemId = '',
        previewZoomMin = 0,
        previewZoomMax = 17,
        initialPreviewSettings = {},
    } = $props();

    setContext(KIT, untrack(() => kit)); // kit is a stable object from index.ts

    // Shared session-data store: a SessionStore instance subscribes to the element manager ONCE and
    // mirrors each feature's element list into rune $state (it's a `.svelte.ts` module, so its runes
    // stay reactive across the boundary). Descendants read it via getContext(SESSION_DATA) and never
    // subscribe themselves. Only session-derived DATA lives here — UI-local state (marks, filter,
    // selection) stays in the consuming component.
    const sessionStore = new SessionStore(untrack(() => kit.session));
    setContext(SESSION_DATA, sessionStore);
    $effect(() => () => sessionStore.dispose());

    let orientation = $state(getOrientation());
    let previewVisible = $state(false);
    let collapsed = $state('none');     // 'none' | 'map' | 'preview'
    let ratio = $state(loadRatio());    // map-panel fraction when both are shown

    // The 3D panel shows exactly while a region is selected — the layout's one piece of kit state.
    $effect(() => kit.session.selectionChanged.on(({ corners }) => {
        previewVisible = !!corners;
        if (!previewVisible) collapsed = 'none';
        notifyLayout();
    }));

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

    // The renderers size themselves to their panel, so poke them after any layout change.
    function notifyLayout() {
        requestAnimationFrame(() => kit.previewController?.resize());
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
            kit.previewController?.resize();
        };
        const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            try { localStorage.setItem('splitRatio', String(ratio)); } catch { /* ignore */ }
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
    }

    let containerEl;

    $effect(() => {
        const onResize = () => { orientation = getOrientation(); notifyLayout(); };
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    });
</script>

<div class="split {orientation}" bind:this={containerEl}>
    <MapPanel
        style={mapStyle}
        {tileProviders}
        {customMaps}
        {initialActiveProviderId}
        {features}
        initialZoom={initialMapZoom}
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
        style={previewStyle}
        canCollapse={showBoth}
        onCollapse={collapsePreview}
        dems={previewDems}
        {features}
        initialDemId={initialPreviewDemId}
        zoomMin={previewZoomMin}
        zoomMax={previewZoomMax}
        initialSettings={initialPreviewSettings}
    />

    {#if collapsed !== 'none'}
        <button class="restore-tab btn btn-xs bg-base-100 border-0 shadow restore-{collapsed}-{orientation}" title="Restore panel" onclick={restore}>⟺</button>
    {/if}
</div>
