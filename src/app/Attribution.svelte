<script lang="ts">
    // An `AttributionDetail`: three at-a-glance fields (provider / homepage / license) plus the
    // official recommended credit line, whose spans may be plain text or links.
    import type { AttributionDetail } from '../kit/maptiles/TileMapManifest';

    let { attribution }: { attribution?: AttributionDetail } = $props();
</script>

{#if attribution}
    <div class="mx-3 mb-2 p-2 rounded bg-base-100 text-xs leading-5">
        <div>Map data by <span class="font-semibold">{attribution.provider}</span></div>
        <div><a class="link link-primary" href={attribution.homepage.url} target="_blank" rel="noopener noreferrer">{attribution.homepage.text}</a></div>
        <div>License: <a class="link link-primary" href={attribution.license.url} target="_blank" rel="noopener noreferrer">{attribution.license.text}</a></div>
        <div class="mt-1 pt-1 border-t border-base-300 opacity-70 whitespace-pre-line">{#each attribution.credit as span}{#if typeof span === 'string'}{span}{:else}<a class="link" href={span.url} target="_blank" rel="noopener noreferrer">{span.text}</a>{/if}{/each}</div>
    </div>
{/if}
