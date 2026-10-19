/*
  A main-world entry whose FIRST match pattern does not match the page and whose second one does.

  That is the shape that failed in Rambox: Dashlane's shadow-DOM entry lists http first, https
  second, and the page was https. Honouring only matches[0] silently drops the entry.
*/
document.documentElement.setAttribute('data-crx-second-pattern', 'ran')
