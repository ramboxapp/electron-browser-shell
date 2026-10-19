/*
  A SECOND main-world content script entry.

  Dashlane declares three of them and does nothing on a login form in Rambox, so "only the first
  entry runs" was the suspicion. It was wrong — all of them run — and the coverage stays, because
  nothing tested it.
*/
document.documentElement.setAttribute('data-crx-main-world-second', 'ran')
