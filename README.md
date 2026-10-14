# Fast Tree Tabs

A tree-style tab sidebar for Firefox.

This project started as a fork of [Tree Style Tab](https://github.com/piroor/treestyletab) by piroor. Credit for the original idea, the interaction design, and years of maintenance goes to piroor and the TST contributors. Fast Tree Tabs contains no code from Tree Style Tab. The code is new.

## Why a rewrite

The original extension kept two complete copies of tab state. The background process held one copy. The sidebar held a second copy. More than one hundred message types kept the two copies synchronized. This design caused three classes of problems:

- The copies went out of synchronization. Tabs landed in unexpected places.
- A full-screen blocking overlay hid intermediate states during slow operations. When the overlay counter went wrong, the sidebar stopped accepting clicks. This failure happened in practice.
- Each tab event cost work in three places: background handling, message transfer, and sidebar re-application.

## The architecture

- The background process owns all state. Each window has one order array and one map of tab records.
- The tree is one field on each tab record: `parentId`. There is no separate tree structure.
- The background flattens the tree into a row list and pushes a versioned snapshot to each connected sidebar.
- The sidebar renders the snapshot. It sends intents back: activate, close, collapse, move.
- No second copy of tab state exists. No reconciliation code exists. No blocking overlay exists.

## The numbers

| Measure | Tree Style Tab | Fast Tree Tabs |
|---|---|---|
| Runtime JavaScript (background + common + sidebar) | ~49,300 lines | ~1,400 lines |
| Protocol message types | 116 | 12 |
| Copies of tab state | 2 | 1 |
| Blocking-overlay code | yes | none |

This is a code-size reduction of about 97%. It is also a desync reduction by construction: one copy of state cannot disagree with itself.

## Benchmark

Measured on this machine, Node.js, the full per-event render pipeline:

| Tabs | Flatten time | Snapshot size |
|---|---|---|
| 100 | 33 us | 14 KB |
| 500 | 149 us | 74 KB |
| 1,000 | 322 us | 149 KB |
| 2,000 | 747 us | 303 KB |
| 5,000 | 2,263 us | 764 KB |

The cost is linear at about 0.3 us per row. A structured-clone `postMessage` of 74 KB costs well under one millisecond. At 500 tabs, a whole frame of state transfer finishes in about half a millisecond.

We did not produce a matching number for Tree Style Tab. Its per-event cost has no single function to time. It is distributed across message handlers, a second copy of the state, about twenty index-map updates per tab change, and a DOM patch. The numbers above measure the *entire* cost of our equivalent path.

## Features

- Tree view with collapse and expand
- Click to activate, middle-click or X to close
- Descendant count doubles as the collapse toggle
- Closing a collapsed tab closes its descendants (optional)
- Multi-select with Ctrl/Cmd+click and Shift+click
- Right-click menu: close, close tree, unload, copy links
- Drag and drop to reorder and reparent, subtree included
- Configurable new-tab placement (Preferences page)
- Session restore and undo-close with tree intact
- Animated reorder, collapse, and expand (optional)

## Not implemented

Pinned tab section, native tab groups, container colors, sound buttons, full context menus, the external addon API, bookmarks integration, localization. Each omission is deliberate. Add a feature only if the projection architecture can express it.

## Install

Load `manifest.json` as a temporary add-on from `about:debugging`. The sidebar opens on install.
