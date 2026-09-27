#!/usr/bin/env node
/**
 * Ditto addon for Luna: adds (or removes) the two lines Ditto needs in the panel's
 * sources — the page's route and the API route that reaches the bot. Safe to run
 * again: nothing is added twice.
 *
 *   node patch.cjs <panel folder> add|remove
 */
const fs = require('fs');
const path = require('path');

const [panel, mode] = process.argv.slice(2);
if (!panel || !['add', 'remove'].includes(mode)) {
    console.error('Usage: node patch.cjs <panel folder> add|remove');
    process.exit(1);
}

const BEGIN = '// ditto-addon:begin';
const END = '// ditto-addon:end';
/** Whole lines between two markers, so they can be found and taken out again exactly. */
const block = (lines, indent = '') => [BEGIN, ...lines, END].map((l) => indent + l).join('\n') + '\n';
const strip = (text) => text.replace(new RegExp(`^[ \\t]*${BEGIN}[\\s\\S]*?${END}[^\\n]*\\n`, 'gm'), '');

function edit(relative, fn) {
    const file = path.join(panel, relative);
    if (!fs.existsSync(file)) throw new Error(`${relative} not found — is this the panel folder?`);
    const before = fs.readFileSync(file, 'utf8');
    const after = fn(strip(before));
    if (after !== before) fs.writeFileSync(file, after);
    console.log(`${mode === 'add' ? 'patched' : 'restored'} ${relative}`);
}

// The page: /server/{id}/ditto, for people with console access.
edit('resources/scripts/routers/routes.ts', (text) => {
    if (mode === 'remove') return text;
    const lazy = block([`const DittoContainer = lazy(() => import('@/components/server/ditto/DittoContainer'));`]);
    const anchor = text.indexOf('interface RouteDefinition');
    if (anchor < 0) throw new Error('routes.ts: could not find "interface RouteDefinition"');
    text = text.slice(0, anchor) + lazy + text.slice(anchor);

    const server = /server:\s*\[[^\n]*\n/.exec(text);
    if (!server) throw new Error('routes.ts: could not find the "server: [" list');
    const at = server.index + server[0].length;
    const route = block(
        ['{', `    path: '/ditto',`, `    permission: 'control.console',`, `    name: 'Ditto',`, '    component: DittoContainer,', '},'],
        '        '
    );
    return text.slice(0, at) + route + text.slice(at);
});

// The API: /api/client/servers/{server}/ditto/…, behind the same checks as every server route.
edit('routes/api-client.php', (text) => {
    if (mode === 'remove') return text;
    for (const needed of ['ServerSubject', 'AuthenticateServerAccess', 'ResourceBelongsToServer']) {
        if (!text.includes(needed)) throw new Error(`api-client.php: ${needed} is not imported any more`);
    }
    const group = block([
        `Route::group([`,
        `    'prefix' => '/servers/{server}/ditto',`,
        `    'middleware' => [ServerSubject::class, AuthenticateServerAccess::class, ResourceBelongsToServer::class],`,
        `], function () {`,
        `    Route::match(['get', 'post', 'patch', 'delete'], '/{path?}', [Client\\Servers\\DittoController::class, 'proxy'])`,
        `        ->where('path', '.*');`,
        `});`,
    ]);
    return `${text.replace(/\s*$/, '')}\n${group}`;
});
