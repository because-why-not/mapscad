<script>
    import { untrack } from 'svelte';

    let {
        tileProviders = [],
        initialActiveProviderId = '',
        onLayerSwitch = () => {},
    } = $props();

    let menuOpen = $state(false);
    let activeProviderId = $state(untrack(() => initialActiveProviderId));
    let providerList = $state(untrack(() => tileProviders));

    // Called by index.ts after the manifest loads / when the active layer changes.
    export function setTileProviders(providers) { providerList = providers; }
    export function setActiveProvider(id) { activeProviderId = id; }

    function handleLayerSwitch(id) {
        if (id === activeProviderId) return;
        activeProviderId = id;
        menuOpen = false;
        onLayerSwitch(id);
    }
</script>

<!-- Menu button (top-right, above map) -->
<button
    class="btn btn-square bg-base-100 shadow-md fixed top-4 right-4 z-[1000] border-0"
    aria-label="Open menu"
    onclick={() => menuOpen = true}
>
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="3" y1="6" x2="21" y2="6"></line>
        <line x1="3" y1="12" x2="21" y2="12"></line>
        <line x1="3" y1="18" x2="21" y2="18"></line>
    </svg>
</button>

{#if menuOpen}
    <button class="fixed inset-0 z-[1999] cursor-default bg-transparent border-0 p-0" aria-label="Close menu" onclick={() => menuOpen = false}></button>
{/if}

<div class="fixed inset-y-0 right-0 w-72 bg-base-200 shadow-2xl z-[2000] flex flex-col transition-transform duration-300 {menuOpen ? 'translate-x-0' : 'translate-x-full'}">
    <div class="flex items-center justify-between px-4 py-3 bg-primary text-primary-content">
        <h2 class="text-lg font-semibold">Map Controls</h2>
        <button class="btn btn-ghost btn-sm btn-circle text-primary-content" onclick={() => menuOpen = false}>✕</button>
    </div>
    <div class="overflow-y-auto flex-1 py-2">
        <div class="px-4 py-1 text-xs font-bold uppercase tracking-wider opacity-50">Map Source</div>
        <ul class="menu px-2">
            {#each providerList as provider (provider.id)}
                <li>
                    <button
                        class={provider.id === activeProviderId ? 'active' : ''}
                        onclick={() => handleLayerSwitch(provider.id)}
                    >
                        <span>{provider.icon}</span>
                        {provider.name}
                    </button>
                </li>
            {/each}
        </ul>
    </div>
</div>
