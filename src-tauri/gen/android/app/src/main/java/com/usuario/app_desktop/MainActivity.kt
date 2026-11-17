package com.usuario.app_desktop

import android.os.Bundle
import android.view.View
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    // Desde Android 15 la app se dibuja detrás de la barra de estado (hora, notificaciones) y de
    // la barra de navegación. Se deja ese espacio libre con un margen interno del tamaño de las
    // barras; abajo también se deja el espacio del teclado para que no tape lo que se escribe.
    val contenido = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(contenido) { vista, insets ->
      val barras = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      )
      val teclado = insets.getInsets(WindowInsetsCompat.Type.ime())
      vista.setPadding(barras.left, barras.top, barras.right, maxOf(barras.bottom, teclado.bottom))
      WindowInsetsCompat.CONSUMED
    }
  }
}
