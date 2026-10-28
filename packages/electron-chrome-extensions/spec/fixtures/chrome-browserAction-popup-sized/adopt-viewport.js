// Proton Pass's popup sizing, reduced: adopt the viewport as the size whenever it differs.
const adopt = () => {
  const root = document.documentElement
  const current = parseFloat(getComputedStyle(root).getPropertyValue('--popup-width'))
  if (Math.abs(root.clientWidth - current) > 1) {
    root.style.setProperty('--popup-width', `${root.clientWidth}px`)
    root.style.setProperty('--popup-height', `${root.clientHeight}px`)
  }
}
addEventListener('load', () => {
  adopt()
  addEventListener('resize', adopt)
})
