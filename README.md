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
| Los vídeos solo se ven si iOS sabe decodificarlos | `Video.play` usa VLC: reproduce **AV1** en cualquier iPhone (por software en los anteriores al 15 Pro), además de MKV, WebM y streams |
| Interfaces limitadas a `UITable`, `Alert` y `WebView` | `UI.view` crea pantallas con los controles de Apple (SwiftUI): botones, interruptores, deslizadores, pickers, formularios y Liquid Glass en iOS 26. Con `WebContent` se combinan con un `WebView`: HTML para el contenido y controles nativos encima |
| Solo scripts | También **miniapps** `.jsx` y `.tsx`: React con vistas de SwiftUI y Liquid Glass que corren dentro de la app, con estado guardado, `<WebView>`, paquetes de npm y acceso a toda la API |
| Portapapeles solo para texto e imagen | `Pasteboard.copyFile` / `pasteFile` con cualquier tipo de archivo |
| Leer archivos siempre completos | `FS.readBytes(path, offset, length)`, `FS.appendText`, `FS.zip` |
| Carpetas externas solo mediante marcadores | `FS.pickFolder('nombre')` recuerda una carpeta para todas las ejecuciones |
| Un bucle infinito bloquea la app | El botón Detener interrumpe incluso un `while (true)` |

Los scripts de Scriptable funcionan sin cambios. Estas APIs están implementadas: `FileManager`, `Request`, `Data`, `Image`, `Alert`, `WebView`, `UITable`, `DrawContext`, `ListWidget`, `Calendar`, `Reminder`, `Contact`, `Location`, `Notification`, `Mail`, `CallbackURL` y el resto de [docs.scriptable.app](https://docs.scriptable.app). Hay tres diferencias:

- Los widgets se ven como vista previa con `presentSmall()` y similares, pero no se instalan en la pantalla de inicio.
- `FileManager.iCloud()` usa la carpeta local.
- Las presentaciones a pantalla completa se cierran agitando el iPhone.

La referencia rápida está dentro de la app (botón 📖) y en [src/lib/api-docs.ts](src/lib/api-docs.ts). La guía completa para escribir scripts, con todas las funciones, opciones y ejemplos, está en [docs/guia-scripts.md](docs/guia-scripts.md).

## Cómo funciona

- **Motor** ([modules/script-engine/ios](modules/script-engine/ios)): un módulo nativo de Expo en Swift. Cada ejecución crea su propio `JSContext` de JavaScriptCore en una cola dedicada, así que los scripts no comparten memoria con la app ni entre sí.
  - Las funciones nativas se registran por nombre en `NativeRegistry` y se agrupan por archivo: `FileAPI`, `NetAPI`, `PhotosAPI`, `MediaAPI`, `UIAPI`, `CryptoAPI`, `CoreAPI` y otros.
  - **Interfaces de los scripts** ([ViewAPI.swift](modules/script-engine/ios/ViewAPI.swift)): `UI.view` envía el árbol de la vista como datos y Swift lo dibuja con SwiftUI. Los controles devuelven eventos numerados, y cada control conserva lo que tocó el usuario hasta que llega un árbol construido después de ese evento, para que no salte hacia atrás. El vidrio usa `glassEffect` en iOS 26 y materiales translúcidos antes.
  - **Reproductor** ([VideoAPI.swift](modules/script-engine/ios/VideoAPI.swift)): `Video.play` usa [MobileVLCKit](https://code.videolan.org/videolan/VLCKit), que decodifica AV1 con dav1d. Es la única dependencia nativa grande: hace que el `.ipa` pase de unos 18 MB a unos 35 MB.
  - Los datos binarios pasan como `Uint8Array` sin convertirse a base64.
- **Runtime JS** ([modules/script-engine/js/prelude.js](modules/script-engine/js/prelude.js)): define las APIs que ven los scripts encima del puente nativo. Incluye [scriptable.js](modules/script-engine/js/scriptable.js) (compatibilidad con Scriptable) y [views.js](modules/script-engine/js/views.js) (`UI.view` y sus componentes).
  - `npm run prelude` lo convierte en `Prelude.swift`.
  - `npm run test:prelude` lo prueba en Node simulando el puente.
- **Miniapps** ([src/miniapp](src/miniapp)): los `.jsx`/`.tsx` se transpilan en el iPhone con Sucrase y corren en el runtime de React Native de la app, dibujados con `@expo/ui` (SwiftUI). Por eso responden al instante, sin el viaje de ida y vuelta de `UI.view`.
  - `runtime.ts` compila, pone una guarda en los bucles (3 s sin dejar dibujar) y ejecuta; `modules.ts` resuelve `./_archivos` y paquetes de esm.sh, guardados en disco.
  - `host.ts` es el puente con la API de Scriptor: cada miniapp mantiene una ejecución del motor en segundo plano y la llama por ruta global (`FS.readText`) con argumentos JSON. Bytes, fechas y callbacks viajan etiquetados. En el motor lo atiende `__hostCall` del prelude.
  - `screen.tsx` es la pantalla: errores con su línea, menú al agitar (expo-sensors) y consola.
- **Python** ([PythonEngine.swift](modules/script-engine/ios/PythonEngine.swift)): los `.py` corren en [Pyodide](https://pyodide.org) 0.29 (Python 3.13 en WebAssembly) dentro de un `WKWebView` oculto, compartido por todas las ejecuciones. iOS no deja cargar código nativo descargado, pero sí WebAssembly, y por eso numpy, pandas o lo que se instale con pip funcionan.
  - El esquema `scriptor-py://` sirve la página ([python-runtime.js](modules/script-engine/js/python-runtime.js)) y guarda en `Library/python` los archivos de Pyodide y las ruedas de PyPI la primera vez que se piden. Lo instalado con pip se recuerda en un lockfile de micropip.
  - El módulo `scriptor` ([scriptor_py.py](modules/script-engine/js/scriptor_py.py)) llama a la API con el mismo puente que las miniapps: cada ejecución de Python tiene detrás una ejecución del motor de JavaScript que atiende `__hostCall`.
  - Detener un script de Python destruye el `WKWebView`: es la única forma de cortar Python a mitad.
  - La Terminal ([src/app/terminal.tsx](src/app/terminal.tsx)) tiene pip, un REPL con sesión y comandos de archivos hechos como pequeños scripts `.js`.
  - `npm run prelude` también genera `PythonPage.swift`; [scripts/test-python.mjs](scripts/test-python.mjs) prueba el runtime en Node con el paquete `pyodide` (variable `PYODIDE_DIR`).
- **Interfaz** (Expo Router, [src/app](src/app)): rejilla de scripts, editor, consola y documentación, con Liquid Glass en iOS 26. Los colores, iconos y espaciados están en [src/theme.ts](src/theme.ts).
  - **Editor nativo** ([ScriptEditorView.swift](modules/script-engine/ios/ScriptEditorView.swift)): un `UITextView` con números de línea, resaltado de JavaScript y Python, autoindentado, cierre de paréntesis, autocompletado de la API y buscar/reemplazar. Lee y guarda el archivo él mismo. Con teclado físico, ⌘R ejecuta y ⌘S guarda.
  - **Color e icono de cada script:** se guardan en la cabecera de Scriptable (`// icon-color: blue; icon-glyph: code;`), así que se conservan si el script vuelve a Scriptable. Se cambian manteniendo pulsado el script, en el mismo menú que Copiar (el archivo al portapapeles), Duplicar, Renombrar y Eliminar. Cada tarjeta lleva una etiqueta con el tipo de archivo (JS, JSX, TSX o PY).
  - **iPad:** la rejilla añade columnas según el ancho, y en el editor la consola y la documentación se abren en una columna lateral.
- **Scripts:** son archivos `.js` en Documents, las miniapps `.jsx` o `.tsx` y los scripts de Python `.py` en la misma carpeta. Se ven en la app Archivos, en *En mi iPhone › Scriptor*. Los módulos para `require()` van en `Documents/modules`.
- **Ejecutar desde fuera:** `scriptor://run/NombreDelScript?clave=valor` ejecuta un script desde Atajos o Safari, y los parámetros llegan en `Script.input`. Una miniapp se abre igual con `scriptor://app/Archivo.jsx?clave=valor`, y los parámetros llegan en `input`.

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

### Ciclo rápido: build Debug + `npx expo start`

Solo hay que compilar cuando cambia el código nativo (Swift, `prelude.js` o los archivos de `modules/script-engine/js`, `app.json` o una dependencia nativa nueva). Para todo lo de `src/` (pantallas, Terminal, documentación, miniapps), basta con una app Debug instalada una vez:

1. Compila el Debug: **Actions › iOS IPA › Run workflow › Debug**, o desde la terminal:

   ```bash
   gh workflow run ios.yml -f configuration=Debug
   ```

2. Instala `Scriptor-Debug.ipa` con Sideloadly, igual que el Release. Usa el mismo bundle ID, así que sustituye al Release; los scripts de Documents se conservan.
3. En el PC, con el iPhone en la misma Wi-Fi:

   ```bash
   npx expo start
   ```

   La primera vez Windows pregunta si deja a Node usar la red: permite las **redes privadas**.
4. Abre Scriptor en el iPhone: aparece el lanzador de desarrollo. Escanea con la cámara el QR que sale en la terminal, o elige el servidor de la lista o escribe `http://IP-del-PC:8081`.

Cada vez que guardas un archivo de `src/`, la app se recarga al momento. Agitar el iPhone abre el menú de desarrollo (recargar, inspector, rendimiento). Para volver a la app normal, instala otra vez el Release.

### Tiempo de compilación en GitHub Actions

El workflow guarda dos cachés entre builds:

- **ccache**: el resultado de compilar C, C++ y Objective-C de los Pods. React Native ya viene precompilado, así que esto ahorra sobre todo en el resto de Pods. El código Swift no pasa por ccache y se compila siempre. El Release y el Debug tienen cachés separadas, y el paso *Ccache statistics* del log dice cuántos archivos se reutilizaron.
- **CocoaPods**: las descargas de los Pods (Hermes, VLCKit…), que se renuevan al cambiar `package-lock.json`.

El primer build tras este cambio tarda lo mismo que antes, porque llena las cachés. Los siguientes las aprovechan.
