export { cn } from "cn"

// Convierte a mayúsculas el texto de una caja mientras se escribe SIN mover el cursor.
// Si solo se hiciera setX(e.target.value.toUpperCase()), el valor del estado no coincide con el
// del input, React lo reemplaza y el cursor salta al final (no se puede escribir en medio).
// Aquí se actualiza el propio input y se restaura la posición del cursor antes de que React lo
// compare, así ya coinciden y React no lo toca.
export function aMayusculas(e: { target: HTMLInputElement }): string {
  const input = e.target
  const valor = input.value
  const mayus = valor.toUpperCase()
  if (mayus !== valor) {
    const { selectionStart, selectionEnd } = input
    input.value = mayus
    // Algunos tipos de input no admiten selección; en ese caso simplemente se ignora
    try {
      input.setSelectionRange(selectionStart, selectionEnd)
    } catch {
      /* sin selección */
    }
  }
  return mayus
}

// true cuando la app corre en el celular/tablet (APK de Android o iOS). Ahí no existe la ventana
// de escritorio, así que no se muestra la barra de título propia (minimizar / maximizar / cerrar).
export const esPlataformaMovil = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
