# Scriptor

Scriptor ejecuta scripts de JavaScript en iOS con acceso a APIs nativas, en la línea de Scriptable pero sin sus límites técnicos. Está pensada para instalarse por sideload: un solo App ID, sin widgets ni extensiones, y funciona con una cuenta gratuita de Apple.

## Qué mejora respecto a Scriptable

| Scriptable | Scriptor |
|---|---|
| `Photos.save()` solo acepta imágenes | `Photos.save(path)` guarda imágenes **y vídeos**, también en un álbum concreto |
| Sin `setTimeout`, `fetch`, `atob`, `TextEncoder`, `URL` ni `crypto` | Incluye todas esas APIs web, además de AES-GCM y HMAC |
| `Request` carga la respuesta entera en memoria y no informa del progreso | `Net.download` y `Net.upload` trabajan por streaming a disco, con progreso y cancelación; también hay WebSocket |
| Sin EXIF, álbumes ni originales | `Photos.metadata`, `Photos.albums`, `Photos.export` (originales HEIC/MOV) |
| Sin vídeo ni audio | `Video.export` (comprimir/recortar), `Video.thumbnail`, `Audio.play`, `Audio.record`, `Camera.video` |
| Portapapeles solo para texto e imagen | `Pasteboard.copyFile` / `pasteFile` con cualquier tipo de archivo |
| Leer archivos siempre completos | `FS.readBytes(path, offset, length)`, `FS.appendText`, `FS.zip` |
| Carpetas externas solo mediante marcadores | `FS.pickFolder('nombre')` recuerda una carpeta para todas las ejecuciones |
| Un bucle infinito bloquea la app | El botón Detener interrumpe incluso un `while (true)` |

Los scripts de Scriptable funcionan sin cambios. Estas APIs están implementadas: `FileManager`, `Request`, `Data`, `Image`, `Alert`, `WebView`, `UITable`, `DrawContext`, `ListWidget`, `Calendar`, `Reminder`, `Contact`, `Location`, `Notification`, `Mail`, `CallbackURL` y el resto de [docs.scriptable.app](https://docs.scriptable.app). Hay tres diferencias:

- Los widgets se ven como vista previa con `presentSmall()` y similares, pero no se instalan en la pantalla de inicio.
- `FileManager.iCloud()` usa la carpeta local.
- Las presentaciones a pantalla completa se cierran agitando el iPhone.

La referencia completa está dentro de la app (botón 📖) y en [src/lib/api-docs.ts](src/lib/api-docs.ts).

## Cómo funciona

- **Motor** ([modules/script-engine/ios](modules/script-engine/ios)): un módulo nativo de Expo en Swift. Cada ejecución crea su propio `JSContext` de JavaScriptCore en una cola dedicada, así que los scripts no comparten memoria con la app ni entre sí.
  - Las funciones nativas se registran por nombre en `NativeRegistry` y se agrupan por archivo: `FileAPI`, `NetAPI`, `PhotosAPI`, `MediaAPI`, `UIAPI`, `CryptoAPI` y `CoreAPI`.
  - Los datos binarios pasan como `Uint8Array` sin convertirse a base64.
- **Runtime JS** ([modules/script-engine/js/prelude.js](modules/script-engine/js/prelude.js)): define las APIs que ven los scripts encima del puente nativo.
  - `npm run prelude` lo convierte en `Prelude.swift`.
  - `npm run test:prelude` lo prueba en Node simulando el puente.
- **Interfaz** (Expo Router, [src/app](src/app)): rejilla de scripts, editor, consola y documentación, con Liquid Glass en iOS 26. Los colores, iconos y espaciados están en [src/theme.ts](src/theme.ts).
  - **Editor nativo** ([ScriptEditorView.swift](modules/script-engine/ios/ScriptEditorView.swift)): un `UITextView` con números de línea, resaltado de JavaScript, autoindentado, cierre de paréntesis, autocompletado de la API y buscar/reemplazar. Lee y guarda el archivo él mismo. Con teclado físico, ⌘R ejecuta y ⌘S guarda.
  - **Color e icono de cada script:** se guardan en la cabecera de Scriptable (`// icon-color: blue; icon-glyph: code;`), así que se conservan si el script vuelve a Scriptable. Se cambian manteniendo pulsado el script.
  - **iPad:** la rejilla añade columnas según el ancho, y en el editor la consola y la documentación se abren en una columna lateral.
- **Scripts:** son archivos `.js` en Documents. Se ven en la app Archivos, en *En mi iPhone › Scriptor*. Los módulos para `require()` van en `Documents/modules`.
- **Ejecutar desde fuera:** `scriptor://run/NombreDelScript?clave=valor` ejecuta un script desde Atajos o Safari, y los parámetros llegan en `Script.input`.

## Compilar sin Mac (GitHub Actions)

1. Crea un repositorio en GitHub y sube esta carpeta (`app/`) como raíz del repositorio.
2. Ve a **Actions › iOS IPA › Run workflow**:
   - **Release:** app independiente. Es la que usarás normalmente.
   - **Debug:** app de desarrollo que carga el JavaScript desde tu PC con `npx expo start`. Así los cambios de interfaz se ven al momento sin volver a compilar. Los cambios en Swift sí requieren compilar de nuevo.
3. Cuando termine, que tarda unos 15-25 minutos, descarga el artefacto `Scriptor-Release-ipa`.

Cada push a `main` también lanza una compilación Release.

## Instalar con cuenta gratuita

1. Instala [Sideloadly](https://sideloadly.io) en Windows. También necesitas iTunes e iCloud en sus versiones de escritorio, no las de Microsoft Store.
2. Conecta el iPhone, arrastra el `.ipa`, escribe tu Apple ID y pulsa Start.
3. En el iPhone:
   - activa **Ajustes › Privacidad y seguridad › Modo de desarrollador**;
   - confía en tu perfil en **Ajustes › General › VPN y gestión de dispositivos**.

Límites de la cuenta gratuita:

- La firma caduca a los **7 días**. Vuelve a instalar con Sideloadly; tus scripts se conservan. AltStore o SideStore pueden renovarla automáticamente.
- Como mucho 3 apps instaladas a la vez y 10 App IDs por semana. Scriptor usa solo uno.
- No hay iCloud, push ni App Groups. Por eso los scripts se guardan en la carpeta local de la app y no en iCloud Drive.

## Desarrollo

```bash
npm install
npm run test:prelude   # pruebas del runtime JS
npm run prelude        # tras editar prelude.js
npm run typecheck
npx expo lint
```
