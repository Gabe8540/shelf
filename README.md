# Shelf (web version)

The web version of Shelf, for iPhone, iPad or any browser. It is built from the Shelf extension's code (`web/build.mjs` in the private Shelf repo) and contains **no reading list and no token**.

When you open it, you connect your private list repo and a token in Settings. The list is read from and saved to that private repo; this site only holds the app.

## Publish (once)

Settings → Pages → **Build and deployment** → Source: **Deploy from a branch**, Branch: **main**, folder **/ (root)**, then Save.

The site appears at `https://gabe8540.github.io/shelf/` within a minute or two.

## On iPhone or iPad

1. Open the site in Safari. Settings opens first: enter your list repo (owner/name) and token, then press Connect.
2. Settings → **Log chapters from Safari**: copy the bookmark code and save it as a Safari bookmark named "Log to Shelf".
3. On a chapter page, open Bookmarks and tap **Log to Shelf**.
4. Optional: Share → **Add to Home Screen**. Connect once there too; it keeps its own copy.
