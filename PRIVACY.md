# Privacy Policy — Old Reddit

_Last updated: 2026-07-24_

**Old Reddit** ("the extension") does **not collect, store, transmit, sell, or
share any personal data.** It has no analytics, no tracking, no accounts, and no
servers operated by the developer.

## What the extension does

The extension runs only on `reddit.com` (and its subdomains such as `www`, `new`,
`sh`, `np`, `amp`). On those pages it re-renders Reddit in the classic "old Reddit"
layout, using data it reads from **Reddit's own website**.

## Data the extension stores

The extension saves a small amount of data **locally on your device**, via the
browser's built-in extension storage (`storage.local`). This never leaves your
device and is never sent to the developer or any third party. It consists only of:

- your settings (enabled/disabled, night mode, infinite scroll);
- your own **filter lists** (subreddits / users / domains / keywords you choose to hide);
- your own **user tags** (labels you attach to Reddit usernames);
- a list of **which comment threads you've opened**, with timestamps, used solely to
  highlight comments that are new since your last visit.

You can clear all of it at any time by removing the extension.

## Network requests

To display Reddit in the old layout, the extension makes requests **only to Reddit
itself** (`reddit.com`), on your behalf, using your existing logged-in Reddit
session — the same requests your browser already makes when you use Reddit. Examples:
subreddit and comment listings (`…/.json`), your identity for the header
(`/api/me.json`), and subreddit info (`…/about.json`).

These requests go **to Reddit, and only to Reddit.** The extension sends **no data
to the developer or to any other party**, and contacts no third-party servers.

## Permissions

- **`storage`** — to save your settings locally (see above).
- **Host access to `reddit.com`** — to run on Reddit pages and read Reddit's own
  data to render the old layout. The extension requests access to no other websites.

## Third parties

None. No third-party services, SDKs, analytics, or advertising are used.

## Changes

If this policy changes, the updated version will be published in this repository.

## Contact

Questions or concerns:
[open an issue](https://github.com/mkornreich/old_reddit/issues) on the project's
GitHub repository.
