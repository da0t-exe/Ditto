<?php

use Pterodactyl\Models\ThemeSettings;

/**
 * Ditto addon for Luna: adds (or removes) the « Ditto » link in the server sidebar,
 * the way Luna's theme editor stores it. It lands under « Overview », after the
 * console; it can then be moved, renamed or limited to some eggs in the theme editor.
 *
 *   php navlink.php <panel folder> add|remove
 */

[$script, $panel, $mode] = array_pad($argv, 3, null);
if (!$panel || !in_array($mode, ['add', 'remove'], true)) {
    fwrite(STDERR, "Usage: php navlink.php <panel folder> add|remove\n");
    exit(1);
}

chdir($panel);
require $panel . '/vendor/autoload.php';
$app = require $panel . '/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();

$nav = ThemeSettings::getValue('layout.nav_links');
if (!is_array($nav) || !isset($nav['categories']) || !is_array($nav['categories'])) {
    echo "The sidebar is not customised in this Luna version: nothing to change.\n";
    exit(0);
}

$isDitto = fn ($link) => is_array($link) && (($link['id'] ?? '') === 'ditto');

// Take any Ditto link out first, so running this twice never adds two.
$had = false;
foreach ($nav['categories'] as &$category) {
    $links = $category['links'] ?? [];
    $kept = array_values(array_filter($links, fn ($l) => !$isDitto($l)));
    $had = $had || count($kept) !== count($links);
    $category['links'] = $kept;
}
unset($category);

if ($mode === 'add') {
    $index = 0;
    foreach ($nav['categories'] as $k => $category) {
        if (($category['id'] ?? '') === 'overview') {
            $index = $k;
            break;
        }
    }
    $orders = array_map(fn ($l) => (int) ($l['order'] ?? 0), $nav['categories'][$index]['links'] ?? []);
    $nav['categories'][$index]['links'][] = [
        'id' => 'ditto',
        'label' => 'Ditto',
        'icon' => 'robot',
        'enabled' => true,
        'order' => $orders ? max($orders) + 1 : 0,
        'egg_filter' => [],
    ];
}

ThemeSettings::updateValue('layout.nav_links', $nav);
echo $mode === 'add'
    ? ($had ? "Ditto link refreshed in the sidebar.\n" : "Ditto link added to the sidebar (Overview).\n")
    : ($had ? "Ditto link removed from the sidebar.\n" : "There was no Ditto link in the sidebar.\n");
