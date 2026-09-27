<?php

use Pterodactyl\Models\Egg;
use Pterodactyl\Models\ThemeSettings;

/**
 * Ditto addon for Luna: adds (or removes) the « Ditto » group of the server sidebar,
 * the way Luna's theme editor stores it: Overview, Captcha, Music, Voice, Bot settings
 * and Logs, just under Luna's own « Overview » group.
 *
 *   php navlink.php <panel folder> add [--eggs=5,12]   add the group (or what is missing from it)
 *   php navlink.php <panel folder> remove              take it out
 *   php navlink.php <panel folder> eggs                list the eggs, for the installer
 *   php navlink.php <panel folder> status              "present" or "absent", for the installer
 *
 * Once added, the group belongs to the theme editor: running this again (after a Luna
 * update) keeps what was changed there — order, names, icons, eggs, hidden entries.
 * --eggs shows the group only on servers of those eggs (the theme editor can change it).
 */

$args = array_slice($argv, 1);
$panel = $args[0] ?? null;
$mode = $args[1] ?? null;
$eggs = null;
foreach (array_slice($args, 2) as $arg) {
    if (preg_match('/^--eggs=([\d,]*)$/', $arg, $m)) {
        $eggs = array_values(array_unique(array_map('intval', array_filter(explode(',', $m[1])))));
    }
}
if (!$panel || !in_array($mode, ['add', 'remove', 'eggs', 'status'], true)) {
    fwrite(STDERR, "Usage: php navlink.php <panel folder> add [--eggs=1,2] | remove | eggs | status\n");
    exit(1);
}

chdir($panel);
require $panel . '/vendor/autoload.php';
$app = require $panel . '/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();

if ($mode === 'eggs') {
    foreach (Egg::query()->withCount('servers')->orderBy('id')->get() as $egg) {
        printf("%d\t%s\t%d\n", $egg->id, $egg->name, $egg->servers_count);
    }
    exit(0);
}

// [id, label, icon, route name (see patch.cjs)]
const DITTO_LINKS = [
    ['ditto', 'Overview', 'robot', 'Ditto'],
    ['ditto-captcha', 'Captcha', 'shield-alt', 'Ditto Captcha'],
    ['ditto-music', 'Music', 'headphones', 'Ditto Music'],
    ['ditto-voice', 'Voice', 'volume-up', 'Ditto Voice'],
    ['ditto-settings', 'Bot settings', 'cog', 'Ditto Settings'],
    ['ditto-logs', 'Logs', 'stream', 'Ditto Logs'],
];

$nav = ThemeSettings::getValue('layout.nav_links');
if (!is_array($nav) || !isset($nav['categories']) || !is_array($nav['categories'])) {
    fwrite(STDERR, "This Luna version keeps its sidebar elsewhere: add the Ditto pages in the theme editor.\n");
    exit(0);
}

if ($mode === 'status') {
    $ids = array_map(fn ($c) => is_array($c) ? ($c['id'] ?? '') : '', $nav['categories']);
    echo in_array('ditto', $ids, true) ? "present\n" : "absent\n";
    exit(0);
}

$isOurs = fn ($link) => is_array($link) && preg_match('/^ditto(-[a-z]+)?$/', (string) ($link['id'] ?? ''));
$groupIndex = null;
foreach ($nav['categories'] as $k => $category) {
    if (($category['id'] ?? '') === 'ditto') {
        $groupIndex = $k;
    }
}

// The single « Ditto » link of the first version of this addon, in another group.
foreach ($nav['categories'] as $k => &$category) {
    if ($k !== $groupIndex && isset($category['links']) && is_array($category['links'])) {
        $category['links'] = array_values(array_filter($category['links'], fn ($l) => !$isOurs($l)));
    }
}
unset($category);

if ($mode === 'remove') {
    if ($groupIndex !== null) {
        array_splice($nav['categories'], $groupIndex, 1);
    }
    ThemeSettings::updateValue('layout.nav_links', $nav);
    echo "Ditto group removed from the sidebar.\n";
    exit(0);
}

$link = fn (array $d, int $order) => [
    'id' => $d[0],
    'label' => $d[1],
    'icon' => $d[2],
    'route' => $d[3],
    'enabled' => true,
    'order' => $order,
    'egg_filter' => $eggs ?? [],
];

if ($groupIndex === null) {
    // A new group, just under Luna's « Overview ».
    usort($nav['categories'], fn ($a, $b) => ((int) ($a['order'] ?? 0)) <=> ((int) ($b['order'] ?? 0)));
    $after = 0;
    foreach ($nav['categories'] as $k => $category) {
        if (($category['id'] ?? '') === 'overview') {
            $after = $k + 1;
        }
    }
    array_splice($nav['categories'], $after, 0, [[
        'id' => 'ditto',
        'label' => 'Ditto',
        'enabled' => true,
        'order' => 0,
        'links' => array_map($link, DITTO_LINKS, array_keys(DITTO_LINKS)),
    ]]);
    foreach ($nav['categories'] as $k => &$category) {
        $category['order'] = $k;
    }
    unset($category);
    $done = 'Ditto group added to the sidebar, under Overview.';
} else {
    // Already there: add what is missing, keep what was changed in the theme editor.
    $group = &$nav['categories'][$groupIndex];
    $group['links'] = is_array($group['links'] ?? null) ? array_values($group['links']) : [];
    $have = array_map(fn ($l) => $l['id'] ?? '', $group['links']);
    $added = 0;
    foreach (DITTO_LINKS as $d) {
        if (!in_array($d[0], $have, true)) {
            $new = $link($d, count($group['links']));
            // Same eggs as the rest of the group.
            foreach ($group['links'] as $l) {
                if ($eggs === null && $isOurs($l) && is_array($l['egg_filter'] ?? null)) {
                    $new['egg_filter'] = $l['egg_filter'];
                    break;
                }
            }
            $group['links'][] = $new;
            $added++;
        }
    }
    if ($eggs !== null) {
        foreach ($group['links'] as &$l) {
            if ($isOurs($l)) {
                $l['egg_filter'] = $eggs;
            }
        }
        unset($l);
    }
    unset($group);
    $done = $added ? "Ditto group completed ({$added} page(s) added)." : 'Ditto group already in the sidebar: kept as it is.';
}

ThemeSettings::updateValue('layout.nav_links', $nav);
echo $done . "\n";
if ($eggs) {
    echo 'Shown on servers of egg(s) ' . implode(', ', $eggs) . ".\n";
}
