<script>
    let {
        style = '',
        canCollapse = false,
        onCollapse = () => {},
    } = $props();

    let mountEl;
    export function getMount() { return mountEl; }

    let menuOpen = $state(false);
</script>

<div class="panel panel-preview" {style}>
    <div class="panel-mount" id="preview-mount" bind:this={mountEl}></div>

    <!-- 3D menu button -->
    <button
        class="btn btn-square bg-base-100 shadow-md absolute top-4 right-4 z-[1000] border-0"
        aria-label="Open 3D menu"
        onclick={() => menuOpen = true}
    >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="3" y1="6" x2="21" y2="6"></line>
            <line x1="3" y1="12" x2="21" y2="12"></line>
            <line x1="3" y1="18" x2="21" y2="18"></line>
        </svg>
    </button>

    {#if canCollapse}
        <button class="collapse-btn btn btn-xs btn-circle bg-base-100 border-0 shadow" title="Hide 3D view" onclick={onCollapse}>›</button>
    {/if}

    {#if menuOpen}
        <button class="absolute inset-0 z-[1999] cursor-default bg-transparent border-0 p-0" aria-label="Close menu" onclick={() => menuOpen = false}></button>
    {/if}

    <div class="absolute inset-y-0 right-0 w-72 bg-base-200 shadow-2xl z-[2000] flex flex-col transition-transform duration-300 {menuOpen ? 'translate-x-0' : 'translate-x-full'}">
        <div class="flex items-center justify-between px-4 py-3 bg-secondary text-secondary-content">
            <h2 class="text-lg font-semibold">3D View</h2>
            <button class="btn btn-ghost btn-sm btn-circle text-secondary-content" onclick={() => menuOpen = false}>✕</button>
        </div>
        <div class="overflow-y-auto flex-1 py-4 px-4 text-sm opacity-60">
            3D controls coming soon.
        </div>
    </div>
</div>
