/*
  A main-world entry whose FIRST match pattern does not match the page and whose second one does.

  That is the shape Dashlane's shadow-DOM entry has: http first, https second, on an https page.
  Honouring only matches[0] would silently drop such an entry. Rambox turned out not to do that,
  but nothing was testing the rule.
*/
document.documentElement.setAttribute('data-crx-second-pattern', 'ran')
