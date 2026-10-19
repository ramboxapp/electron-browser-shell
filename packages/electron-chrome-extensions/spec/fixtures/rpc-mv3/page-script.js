/*
  A script that an extension serves from its own origin and a content script injects into the page's
  MAIN world with a <script src> tag. Password managers do this to reach page internals the isolated
  world cannot see; Dashlane's form classification waits on a handshake with exactly such a script.

  It needs `web_accessible_resources`, so this also covers that the page is allowed to load it.
*/
document.documentElement.setAttribute('data-crx-page-script', 'ran')
document.dispatchEvent(new CustomEvent('crx-page-script-ready'))
