/*
  A SECOND main-world content script entry.

  Dashlane declares three of them and only the first ran in Rambox, which left its form classifier
  without the handshake its page scripts provide — the extension looked alive and did nothing.
*/
document.documentElement.setAttribute('data-crx-main-world-second', 'ran')
