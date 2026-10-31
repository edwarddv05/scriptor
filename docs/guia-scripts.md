# Guía para escribir scripts en Scriptor

Esta guía explica cómo se escribe un script y documenta todas las funciones que tiene disponibles. La referencia corta que aparece en la app (botón 📖) sale de [src/lib/api-docs.ts](../src/lib/api-docs.ts); aquí está la versión completa, con opciones, valores de retorno y ejemplos.

Contenido:

1. [Lo básico](#1-lo-básico)
2. [Ciclo de vida de un script](#2-ciclo-de-vida-de-un-script)
3. [Entrada, salida y ejecución desde fuera](#3-entrada-salida-y-ejecución-desde-fuera)
4. [Módulos: `require` y `requireURL`](#4-módulos-require-y-requireurl)
5. [Consola y temporizadores](#5-consola-y-temporizadores)
6. [Texto, Base64, URL y criptografía](#6-texto-base64-url-y-criptografía)
7. [Red](#7-red)
8. [Archivos (`FS`)](#8-archivos-fs)
9. [Fotos y cámara](#9-fotos-y-cámara)
10. [Imagen, vídeo, audio y voz](#10-imagen-vídeo-audio-y-voz)
11. [Interfaz](#11-interfaz)
12. [Portapapeles, notificaciones, dispositivo y llavero](#12-portapapeles-notificaciones-dispositivo-y-llavero)
13. [Compatibilidad con Scriptable](#13-compatibilidad-con-scriptable)
14. [Errores frecuentes](#14-errores-frecuentes)
15. [Recetas](#15-recetas)
16. [Miniapps (`.jsx` y `.tsx`)](#16-miniapps-jsx-y-tsx)
17. [Python (`.py`)](#17-python-py)

---

## 1. Lo básico

Un script es un archivo `.js` dentro de la carpeta Documents de la app. En la app Archivos se ve en *En mi iPhone › Scriptor*.

```js
// icon-color: blue; icon-glyph: code;
// Saluda y muestra la batería.
const info = Device.info();
console.log('Batería:', Math.round(info.battery * 100) + '%');
await alert('Hola desde ' + Script.name());
```

- **Cabecera.** La línea `// icon-color: …; icon-glyph: …;` fija el color y el icono del script en la rejilla. Usa el mismo formato que Scriptable, así que se conserva si llevas el script allí. Puedes cambiarlos manteniendo pulsado el script. En ese mismo menú, **Copiar** pone el archivo en el portapapeles: en Archivos o Mail se pega como archivo y en un campo de texto como código.
- **Resumen.** El primer comentario normal (`// …`) del principio del archivo aparece como descripción en la lista.
- **`await` y `return` en el nivel superior.** Tu código se ejecuta dentro de una función `async`, así que puedes escribir `await` sin envolverlo en nada, y `return valor` termina el script y muestra ese valor como resultado.
- **Aislamiento.** Cada ejecución tiene su propio motor de JavaScript (JavaScriptCore). Dos scripts no comparten variables, ni siquiera dos ejecuciones del mismo script.

### Rutas

Todas las funciones que reciben una ruta la interpretan así:

| Forma | Ejemplo | Se resuelve a |
|---|---|---|
| Relativa | `'datos/lista.json'` | `Documents/datos/lista.json` |
| Absoluta | `FS.join(FS.cache, 'x.bin')` | Tal cual |
| URL de archivo | `'file:///…'` | La ruta de esa URL |

Las funciones que **crean** un archivo (descargas, conversiones, exportaciones…) aceptan un destino opcional:

- Si no lo indicas, el archivo se crea en una carpeta temporal con un nombre único y la función te devuelve su ruta.
- Si lo indicas y ya existe, **se sobrescribe**. Las carpetas que falten se crean solas.

### Valores binarios

Los bytes se manejan siempre como `Uint8Array`. Cualquier función que pida bytes acepta también `ArrayBuffer`, otros arrays tipados y objetos `Data` de Scriptable.

---

## 2. Ciclo de vida de un script

1. Se carga el runtime (todas las APIs de esta guía).
2. Se ejecuta tu código.
3. El script termina cuando **tu código ha acabado y no queda nada pendiente**: ni temporizadores, ni peticiones de red, ni sockets abiertos, ni diálogos. Funciona igual que el bucle de eventos de Node.

Esto significa que un `setInterval` que no se cancela mantiene el script vivo. Para terminar de golpe, usa `Script.complete()`.

| Cómo acaba | Qué ves en la consola |
|---|---|
| El código termina con normalidad | El valor de `return`, si lo hay |
| Se lanza un error que nadie captura | El error con su traza; el script se marca como fallido |
| `Script.complete(resultado)` | Termina al momento, aunque queden temporizadores |
| Botón **Detener** | Se interrumpe incluso dentro de un `while (true)` |

Las promesas rechazadas que nadie gestiona no detienen el script; aparecen como aviso: `Unhandled promise rejection: …`.

### En segundo plano

Si sales de Scriptor mientras un script `.js` o `.py` se está ejecutando, su consola se abre en una ventana de **Picture in Picture** con las últimas líneas. Mientras esa ventana está abierta, iOS no suspende la app, así que el script sigue hasta terminar. Puedes esconder la ventana en el borde de la pantalla y seguirá corriendo. Al acabar, la ventana muestra *Terminado* o el error durante unos segundos y se cierra sola. Al volver a Scriptor también se cierra.

- Si cierras la ventana con la ✕, iOS puede suspender la app a los pocos segundos.
- Python corre en un proceso aparte que iOS suspende aunque la app siga activa. Para evitarlo, mientras un `.py` se ejecuta, Python reproduce un tono inaudible.
- Las miniapps no la abren: se pausan al salir.
- La sesión de audio se activa en modo mezcla, así que la música que estés escuchando no se corta.

> **Pantallas a pantalla completa.** Las tablas y webs presentadas con `fullscreen = true` no tienen botón de cerrar. Agita el iPhone para que aparezca una barra con la opción de salir.

---

## 3. Entrada, salida y ejecución desde fuera

### Ejecutar desde Atajos o Safari

```
scriptor://run/NombreDelScript?ciudad=Madrid&dias=3
```

Los parámetros llegan al script como texto:

```js
const ciudad = Script.input.ciudad ?? 'Sevilla';
const dias = Number(args.dias ?? 1);
```

### `Script`

| Función | Descripción |
|---|---|
| `Script.name()` | Nombre del script sin `.js`. También funciona como texto: `` `${Script.name}` ``. |
| `Script.input` | Objeto con los parámetros de entrada. Es el mismo que la variable global `args`. |
| `Script.complete(resultado?)` | Termina el script inmediatamente, con un resultado opcional. |
| `Script.setShortcutOutput(valor)` | Fija el resultado que se usa si el script no hace `return`. |
| `Script.setWidget()` | No hace nada en Scriptor (ver [Compatibilidad](#13-compatibilidad-con-scriptable)). |

### Otras variables globales

| Nombre | Contenido |
|---|---|
| `args` | Los parámetros de entrada; además `args.queryParameters` (los mismos) y los campos de Scriptable (`plainTexts`, `urls`, `images`…) vacíos. |
| `config` | `config.runsInApp` es `true`; el resto de `runsIn…` son `false` y `widgetFamily` es `null`. |
| `URLScheme` | `forRunningScript()` devuelve la URL `scriptor://run/…` de este script; `parameter(nombre)` y `allParameters()` leen la entrada. |
| `module` | `module.filename` es la ruta del script. |

---

## 4. Módulos: `require` y `requireURL`

### `require(nombre)`

Carga un módulo CommonJS (lo que exporta con `module.exports` o `exports`).

```js
// Documents/modules/util.js
module.exports.suma = (a, b) => a + b;

// Tu script
const { suma } = require('util');
console.log(suma(2, 3)); // 5
```

Dónde busca, en orden:

| Nombre | Busca en |
|---|---|
| `'/ruta/absoluta'` | Esa ruta |
| `'./lib'` o `'../lib'` | Relativo al archivo que llama (para el script, Documents) |
| `'util'` | `Documents/modules/` y después `Documents/` |

Para cada candidato prueba el nombre tal cual, con `.js`, con `.json` y como carpeta con `index.js`. Los `.json` se devuelven ya parseados. Cada módulo se evalúa una sola vez por ejecución; las siguientes llamadas devuelven lo mismo.

Dentro de un módulo existen `module`, `exports`, `require`, `__filename` y `__dirname`. `importModule` es un alias de `require`, por compatibilidad con Scriptable.

### `await requireURL(url, { reload? })`

Descarga una librería UMD o CommonJS (por ejemplo de unpkg o jsDelivr) y la guarda en caché en disco. Las siguientes ejecuciones no vuelven a descargarla; pasa `{ reload: true }` para forzarlo.

```js
const dayjs = await requireURL('https://unpkg.com/dayjs@1.11.13/dayjs.min.js');
console.log(dayjs().format('DD/MM/YYYY'));
```

Solo funcionan librerías que no dependan del DOM ni de módulos de Node.

---

## 5. Consola y temporizadores

### `console`

| Función | Descripción |
|---|---|
| `console.log / info / debug / warn / error(...valores)` | Escribe en la consola. Los objetos, `Map`, `Set`, fechas, errores y arrays binarios se muestran formateados. |
| `console.table(datos)` | Igual que `log`. |
| `console.time(etiqueta?)` / `console.timeEnd(etiqueta?)` | Mide el tiempo entre las dos llamadas y lo escribe en ms. |
| `console.assert(condición, ...valores)` | Escribe un error si la condición es falsa. |

`log`, `logWarning` y `logError` existen también como funciones globales (Scriptable).

### Temporizadores

| Función | Descripción |
|---|---|
| `setTimeout(fn, ms, ...args)` | Ejecuta `fn` una vez. Devuelve un id. |
| `setInterval(fn, ms, ...args)` | Ejecuta `fn` cada `ms`. **Mantiene vivo el script** hasta que lo canceles. |
| `clearTimeout(id)` / `clearInterval(id)` | Cancela. |
| `await sleep(ms)` | Espera sin bloquear. |
| `queueMicrotask(fn)` | Ejecuta `fn` en cuanto termine la tarea actual. |

```js
let n = 0;
const id = setInterval(() => {
  console.log('tic', ++n);
  if (n === 3) clearInterval(id); // sin esto, el script no terminaría
}, 1000);
```

---

## 6. Texto, Base64, URL y criptografía

### Texto y Base64

| Función | Devuelve |
|---|---|
| `new TextEncoder().encode(texto)` | `Uint8Array` en UTF-8 |
| `new TextDecoder().decode(bytes)` | Texto. Solo admite UTF-8. |
| `btoa(binario)` / `atob(b64)` | Igual que en el navegador: trabajan con cadenas de un carácter por byte. |
| `Base64.encode(bytes \| texto)` | Base64. El texto se codifica como UTF-8, así que admite acentos y emojis. |
| `Base64.decode(b64)` | `Uint8Array` |
| `Base64.decodeText(b64)` | Texto UTF-8 |
| `Hex.encode(bytes)` / `Hex.decode(hex)` | Hexadecimal ↔ `Uint8Array` |
| `structuredClone(valor)` | Copia profunda; conserva `Date`, `Map`, `Set`, `RegExp` y arrays binarios. |

> Para texto con acentos usa `Base64.encode('canción')`, no `btoa('canción')`: `btoa` lanza un error con caracteres que no caben en un byte.

### `URL` y `URLSearchParams`

Funcionan como en el navegador: `href`, `origin`, `protocol`, `host`, `hostname`, `port`, `pathname`, `search`, `hash` y `searchParams` (con `get`, `set`, `append`, `delete`, `has`, `getAll`, `sort` y la iteración). También existe `URL.canParse(texto)`.

```js
const url = new URL('https://api.example.com/buscar');
url.searchParams.set('q', 'café');
url.searchParams.set('page', 2);
console.log(url.href); // https://api.example.com/buscar?q=caf%C3%A9&page=2
```

### Criptografía

| Función | Descripción |
|---|---|
| `crypto.getRandomValues(arrayTipado)` | Rellena el array con bytes aleatorios seguros y lo devuelve. |
| `crypto.randomUUID()` | UUID v4 en minúsculas. |
| `await crypto.subtle.digest('SHA-256', datos)` | `ArrayBuffer` con el hash. Admite SHA-1, SHA-256, SHA-384 y SHA-512. |
| `Crypto.hash(alg, datos, salida = 'hex')` | `alg`: `md5`, `sha1`, `sha256`, `sha384`, `sha512`. `salida`: `'hex'`, `'base64'` o `'bytes'`. |
| `Crypto.hmac(alg, clave, datos, salida = 'hex')` | HMAC con cualquiera de esos algoritmos. |
| `Crypto.randomBytes(n)` | `Uint8Array` de `n` bytes aleatorios. |
| `Crypto.uuid()` | Igual que `crypto.randomUUID()`. |
| `Crypto.encrypt(clave, datos)` | Cifra con AES-GCM. La clave debe tener 16, 24 o 32 bytes. Devuelve `Uint8Array` con nonce + texto cifrado + etiqueta. |
| `Crypto.decrypt(clave, datos)` | Lo contrario de `encrypt`. Lanza un error si la clave no es la correcta o los datos se han modificado. |

`datos` y `clave` pueden ser texto o bytes.

```js
const clave = Crypto.randomBytes(32);
const cifrado = Crypto.encrypt(clave, 'mensaje secreto');
const texto = new TextDecoder().decode(Crypto.decrypt(clave, cifrado));
```

---

## 7. Red

### `await fetch(url, opciones?)`

El `fetch` estándar, con algunas opciones extra.

| Opción | Descripción |
|---|---|
| `method` | `GET` por defecto, o `POST` si hay `body`. |
| `headers` | Objeto, array de pares o `Headers`. |
| `body` | `string`, `Uint8Array`/`ArrayBuffer`, `Blob`, `FormData` o `URLSearchParams`. Los objetos hay que pasarlos por `JSON.stringify`. |
| `signal` | De un `AbortController`, para cancelar. |
| `timeout` | En **milisegundos**. |
| `redirect` | `'manual'` para no seguir redirecciones. |
| `onProgress` | `(e) => …` con `e.loaded` y `e.total` en bytes (`total` es `-1` si el servidor no lo indica). |

La respuesta tiene `status`, `ok`, `statusText`, `url`, `headers` y los métodos `text()`, `json()`, `bytes()`, `arrayBuffer()`, `blob()` y `clone()`. El cuerpo solo se puede leer una vez.

Si la petición falla por la red, `fetch` lanza `TypeError: fetch failed: …`. Un 404 o un 500 **no** lanzan error: compruébalo con `res.ok`.

```js
const res = await fetch('https://api.example.com/items', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ nombre: 'nuevo' }),
  timeout: 10_000,
});
if (!res.ok) throw new Error('HTTP ' + res.status);
const datos = await res.json();
```

### `await Net.download(url, destino?, opciones?)`

Descarga directamente a disco, sin cargar el archivo en memoria, así que sirve para archivos de varios GB.

- `destino` es opcional; también puedes pasar las opciones como segundo argumento.
- Opciones: `headers`, `method`, `timeout` (ms), `onProgress`, `signal`.
- Devuelve `{ path, size, status, headers, url }`.

```js
const { path, size } = await Net.download('https://example.com/video.mp4', 'descargas/video.mp4', {
  onProgress: (e) => console.log(Math.round((e.loaded / e.total) * 100) + '%'),
});
```

### `await Net.upload(url, ruta, opciones?)`

Sube un archivo leyéndolo desde disco. Usa `POST` por defecto. Acepta `method`, `headers`, `timeout` y `onProgress`, y devuelve una respuesta como la de `fetch`.

### `await Net.webCookies(dominio?)`

Las cookies que guardan los navegadores internos (el `WebView` de los scripts y el `<WebView>` de las miniapps comparten almacén) para un dominio y sus subdominios. Sirve para iniciar sesión una vez en una web y luego hacer peticiones con esa sesión.

```js
const cookies = await Net.webCookies('instagram.com');
// [{ name, value, domain, path, expires, secure, httpOnly }]
const cookie = cookies.map((c) => c.name + '=' + c.value).join('; ');
const res = await fetch('https://www.instagram.com/api/v1/...', { headers: { Cookie: cookie } });
```

- `expires` va en milisegundos, como `Date.now()`; las cookies de sesión no lo traen.
- Sin dominio devuelve todas.
- `await Net.clearWebCookies(dominio?)` cierra la sesión de ese dominio (o de todas las webs) y devuelve cuántas cookies borró.

### `await Net.serve(puerto, manejador, opciones?)`

Abre un servidor HTTP en el iPhone que responde con tu función. Vive mientras el script esté en marcha: al pulsar Detener, o con `Net.stopServer(puerto)`, se cierra. Si sales de la app, el Picture in Picture lo mantiene abierto (ver [En segundo plano](#en-segundo-plano)).

```js
await Net.serve(8080, async (req) => {
  if (req.path === '/') return '<h1>Hola desde Scriptor</h1>';
  if (req.path === '/hora') return { hora: new Date().toISOString() };
  if (req.path === '/foto') return { file: 'Imagenes/foto.jpg' };
  return null; // 404
}, { onStart: ({ url }) => console.log('Abierto en', url) });
```

- **La petición** (`req`): `method`, `path`, `url` (con la query), `query` (objeto), `headers` (en minúsculas), `body` (`Uint8Array`), `text` (el cuerpo como texto) y `address` (quién llama).
- **La respuesta** es lo que devuelve la función (puede ser `async`):
  - un texto, que se envía como HTML si empieza por `<` o como texto plano si no;
  - un objeto o una lista, que se envía como JSON;
  - bytes (`Uint8Array`);
  - `{ status, headers, body }` para controlarlo todo, o `{ file: 'ruta' }` para enviar un archivo con su tipo;
  - `null` o nada, que da un 404.
- Si la función lanza un error, el navegador recibe un 500 y el error sale en la consola.
- **Opciones:** `onStart({ port, url, addresses })` se llama al abrirse. `lan: true` lo abre también a otros dispositivos de tu Wi-Fi: `addresses` trae sus URLs, e iOS pide permiso de red local la primera vez. Sin `lan`, solo lo ve este iPhone (Safari en `http://localhost:8080`). `signal` (un `AbortController`) lo cierra.
- El puerto `0` elige uno libre. Si el puerto está ocupado, la promesa falla con un mensaje.
- La promesa de `Net.serve` no termina mientras el servidor está abierto. Si después de abrirlo quieres hacer otras cosas, no la esperes con `await`: guárdala y sigue.

Desde Python funciona igual. La función puede ser `async def` y devolver un `dict`, un `str` o `bytes`:

```python
from scriptor import Net

async def responder(req):
    if req['path'] == '/':
        return '<h1>Hola desde Python</h1>'
    return {'status': 404, 'body': 'No existe'}

await Net.serve(8080, responder, onStart=lambda info: print('Abierto en', info['url']))
```

### `WebSocket`

```js
const ws = new WebSocket('wss://echo.websocket.org');
ws.onopen = () => ws.send('hola');
ws.onmessage = (e) => { console.log(e.data); ws.close(); };
ws.onclose = (e) => console.log('cerrado', e.code);
```

Tiene `onopen`, `onmessage`, `onerror`, `onclose`, `addEventListener`, `send(texto | bytes)`, `close(código?, motivo?)`, `readyState` y `binaryType` (los mensajes binarios llegan como `ArrayBuffer`). Un socket abierto mantiene vivo el script.

### Otras clases

| Clase | Uso |
|---|---|
| `AbortController` | `controller.abort()` cancela un `fetch` o una descarga. `AbortSignal.timeout(ms)` crea una señal que se cancela sola. |
| `FormData` | `append(nombre, valor)`, `appendFile(nombre, ruta, nombreArchivo?, tipo?)`. Se envía como `multipart/form-data`. |
| `Headers`, `Blob`, `File`, `Response` | Como en el navegador. `headers.toObject()` es un extra. |

---

## 8. Archivos (`FS`)

Todas las funciones de `FS` son **síncronas** salvo las marcadas con `await`.

### Carpetas base

| Propiedad | Carpeta |
|---|---|
| `FS.documents` | Documents. Visible en la app Archivos y donde viven los scripts. |
| `FS.cache` | Caché. iOS puede vaciarla si falta espacio. |
| `FS.temp` | Temporales. |
| `FS.library` | Library: datos internos que no se ven en Archivos. |
| `FS.join(...partes)` | Une partes de una ruta. |

### Leer y escribir

| Función | Descripción |
|---|---|
| `FS.readText(ruta)` / `FS.readJSON(ruta)` | Lee texto UTF-8 o JSON. |
| `FS.readBytes(ruta, offset?, longitud?)` | Lee bytes. Con `offset` lee solo ese trozo sin cargar el resto. |
| `FS.writeText(ruta, texto)` | Escribe texto. Devuelve la ruta absoluta. |
| `FS.writeJSON(ruta, valor)` | Escribe JSON con sangría. |
| `FS.writeBytes(ruta, bytes)` | Escribe bytes. |
| `FS.appendText(ruta, texto)` / `FS.appendBytes(ruta, bytes)` | Añade al final; crea el archivo si no existe. |

Las escrituras crean las carpetas que falten.

### Explorar y organizar

| Función | Descripción |
|---|---|
| `FS.exists(ruta)` / `FS.isDir(ruta)` | `true` o `false`. |
| `FS.list(carpeta?)` | Nombres ordenados alfabéticamente. Sin argumento lista Documents. |
| `FS.stat(ruta)` | `{ path, size, isDir, created, modified, type }`. Las fechas van en ms y `type` es el UTI (`public.jpeg`…). |
| `FS.mkdir(carpeta)` | Crea la carpeta y las intermedias. |
| `FS.remove(ruta)` | Borra un archivo o una carpeta entera. No falla si no existe. |
| `FS.move(desde, hasta)` / `FS.copy(desde, hasta)` | Devuelven la ruta final. **Sobrescriben** el destino si existe. |
| `await FS.zip(carpeta, destino?)` | Comprime un archivo o una carpeta y devuelve la ruta del `.zip`. |

### Selectores y carpetas externas

| Función | Descripción |
|---|---|
| `await FS.pickFile({ types? })` | Abre el selector de Archivos. Devuelve la ruta de una **copia local**, o `null` si se cancela. |
| `await FS.pickFiles({ types?, multiple? })` | Igual, pero devuelve un array de rutas. |
| `await FS.pickFolder(nombre)` | El usuario elige una carpeta de cualquier sitio (iCloud Drive, USB…). Se recuerda con ese nombre para siempre. Devuelve su ruta o `null`. |
| `FS.bookmark(nombre)` | Ruta de una carpeta recordada, o `null`. Funciona en cualquier ejecución posterior. |
| `FS.bookmarks()` / `FS.removeBookmark(nombre)` | Lista u olvida carpetas recordadas. |
| `await FS.exportFile(ruta \| rutas)` | El usuario guarda una copia donde quiera. Devuelve las rutas elegidas. |

`types` admite UTIs (`'public.image'`, `'com.adobe.pdf'`) o extensiones (`'pdf'`, `'csv'`).

```js
// La primera vez pide la carpeta; después la reutiliza sin preguntar.
const dir = FS.bookmark('Facturas') ?? (await FS.pickFolder('Facturas'));
if (!dir) return 'Cancelado';
for (const nombre of FS.list(dir)) console.log(nombre);
```

---

## 9. Fotos y cámara

Todo lo que sale de la fototeca es un **archivo**: las funciones devuelven rutas, no imágenes en memoria. La primera vez iOS pide permiso.

| Función | Devuelve |
|---|---|
| `await Photos.pick({ type?, limit? })` | `[{ path, type, filename, id? }]`. `type`: `'image'`, `'video'` o `'any'` (por defecto). `limit`: 1 por defecto. Array vacío si se cancela. |
| `await Photos.latest({ type?, limit?, album?, favorites? })` | Los elementos más recientes, del más nuevo al más antiguo (10 por defecto). `type` admite también `'screenshot'`. |
| `await Photos.export(id, destino?)` | Ruta del **archivo original** (HEIC, MOV, RAW…). Lo descarga de iCloud si hace falta. |
| `await Photos.save(ruta, { album? })` | Guarda una imagen **o un vídeo** en el carrete. Devuelve el id. `album` debe existir ya. |
| `await Photos.albums()` | `[{ id, title, count, smart }]` |
| `await Photos.createAlbum(título)` | Id del álbum. Si ya existe uno con ese nombre, devuelve el suyo. |
| `await Photos.delete(id \| ids)` | Borra; iOS muestra su propia confirmación. |
| `Photos.metadata(ruta)` | Diccionario EXIF, GPS y TIFF de cualquier archivo de imagen. |
| `await Camera.photo({ front? })` | Ruta de la foto, o `null` si se cancela. |
| `await Camera.video({ maxDuration?, front? })` | Ruta del vídeo, o `null`. `maxDuration` en segundos. |

Cada elemento de `Photos.latest` tiene `{ id, type, width, height, duration, favorite, livePhoto, screenshot, date, location }`. `date` va en ms y `location` es `{ latitude, longitude, altitude }` (solo si la foto tiene ubicación).

```js
const [captura] = await Photos.latest({ type: 'screenshot', limit: 1 });
if (captura) {
  const ruta = await Photos.export(captura.id);
  await UI.share(ruta);
}
```

---

## 10. Imagen, vídeo, audio y voz

Todas reciben una ruta (o un `Image` de Scriptable) y devuelven la **ruta de un archivo nuevo**; el original no se modifica.

### Imagen

| Función | Descripción |
|---|---|
| `Image.info(ruta)` | `{ width, height, type, frames }`. `frames` es mayor que 1 en GIF animados. |
| `await Image.resize(ruta, { width?, height?, format?, quality?, dest? })` | Reduce sin cargar la imagen completa en memoria y mantiene la proporción: el lado más largo queda en el mayor de `width` y `height`. |
| `await Image.crop(ruta, { x, y, width, height, format?, quality?, dest? })` | Recorta en píxeles. |
| `await Image.convert(ruta, formato \| { format, quality?, dest? })` | Cambia de formato. |

`format`: `'jpeg'`, `'png'` o `'heic'`. `quality`: de 0 a 1 (0,9 por defecto).

### Vídeo

| Función | Descripción |
|---|---|
| `await Video.play(ruta \| url, { loop?, start?, muted? })` | Reproduce a pantalla completa con controles (Liquid Glass en iOS 26). Usa VLC, así que lee **AV1** (decodificado por software, también en iPhone sin AV1 por hardware), HEVC, H.264, VP9, MKV, WebM y más, desde un archivo o una URL (`http`, `https`, `rtsp`…). `start` en segundos. Termina al cerrarlo o al acabar el vídeo y devuelve `{ position, duration, ended }`. |
| `await Video.info(ruta)` | `{ duration, hasAudio, hasVideo, width, height, fps, size }`. Duración en segundos, tamaño en bytes. |
| `await Video.thumbnail(ruta, { time?, maxSize? })` | Un fotograma como imagen. `time` en segundos. |
| `await Video.export(ruta, { quality?, start?, end?, dest?, onProgress? })` | Comprime, recorta o recodifica. `start`/`end` en segundos. `onProgress` recibe `{ progress }` de 0 a 1. |
| `await Video.extractAudio(ruta, destino?)` | Saca el audio a `.m4a`. |

`quality`: `low`, `medium` (por defecto), `high`, `hevc`, `720p`, `1080p`, `4k`, `passthrough` (sin recodificar, útil para recortar rápido).

```js
const [video] = await Photos.pick({ type: 'video' });
if (video) {
  const salida = await Video.export(video.path, {
    quality: '720p',
    end: 30,
    onProgress: ({ progress }) => console.log(Math.round(progress * 100) + '%'),
  });
  await Photos.save(salida);
}
```

### Audio y voz

| Función | Descripción |
|---|---|
| `await Audio.play(ruta, { volume?, loop?, rate? })` | Reproduce y espera a que termine. `volume` de 0 a 1. |
| `await Audio.record(destino?, { duration? })` | Graba del micrófono a `.m4a`. Sin `duration` graba hasta `Audio.stop()`. Devuelve la ruta. |
| `Audio.stop()` | Para todas las reproducciones y grabaciones del script; sus promesas se resuelven. |
| `await Speech.speak(texto, { language?, rate?, pitch? })` | Lee en voz alta y espera a que termine. `language` como `'es-ES'`; `rate` multiplica la velocidad normal. |

---

## 11. Interfaz

### Diálogos rápidos

Son **asíncronos**: necesitan `await`, a diferencia del navegador.

| Función | Devuelve |
|---|---|
| `await alert(mensaje, título?)` | Nada |
| `await confirm(mensaje, título?)` | `true` si se pulsa OK |
| `await prompt(mensaje, valorInicial?, título?)` | El texto escrito, o `null` si se cancela |

### `UI`

| Función | Descripción |
|---|---|
| `await UI.alert(título, mensaje, opciones?)` | Alerta completa. Devuelve `{ index, values }`: `index` es el botón pulsado (-1 si se cancela) y `values` lo escrito en cada campo. |
| `await UI.menu(título, opciones)` | Hoja de opciones. Devuelve el índice elegido, o -1. |
| `await UI.share(elementos)` | Hoja de compartir con textos, URLs o rutas de archivos. Devuelve el tipo de actividad, o `null` si se cancela. |
| `await UI.preview(ruta \| rutas)` | Quick Look: vídeos, audio, PDF, imágenes y documentos. Termina al cerrarlo. Usa el decodificador de iOS: para AV1 en iPhone anteriores al 15 Pro, MKV o WebM usa [`Video.play`](#vídeo). |
| `UI.haptic(tipo)` | Vibración: `success`, `warning`, `error`, `light`, `medium`, `heavy`, `selection`. |
| `await UI.open(url)` | Abre una URL o un esquema de otra app (`shortcuts://…`). Devuelve `true` si se pudo abrir. |

Opciones de `UI.alert`:

| Opción | Descripción |
|---|---|
| `buttons` | Array de títulos. `['OK']` por defecto. |
| `cancel` | Título del botón de cancelar (devuelve `index: -1`). |
| `destructive` | **Índice** del botón que se pinta en rojo. |
| `fields` | `[{ placeholder?, value?, secure? }]`. `secure` oculta el texto. |

```js
const r = await UI.alert('Iniciar sesión', 'Introduce tus datos', {
  buttons: ['Entrar'],
  cancel: 'Cancelar',
  fields: [{ placeholder: 'Usuario' }, { placeholder: 'Contraseña', secure: true }],
});
if (r.index === 0) {
  const [usuario, clave] = r.values;
  Keychain.set('usuario', usuario);
}
```

### Interfaces nativas con `UI.view`

`UI.view` crea pantallas con los controles de Apple: los mismos botones, interruptores, deslizadores, listas y formularios que usan las apps del sistema. En iOS 26 tienen Liquid Glass. Por dentro es SwiftUI.

Una vista se escribe como una función que recibe el **estado** y devuelve lo que se ve. Cuando cambias el estado, la pantalla se redibuja sola:

```js
const ui = UI.view({ contador: 0, wifi: true }, (s) =>
  VStack({ spacing: 16 }, [
    Text('Contador: ' + s.contador).font('largeTitle').fontWeight('bold'),
    Toggle('Wi-Fi', s.wifi, (v) => s.wifi = v),
    Slider(s.contador, { min: 0, max: 10, step: 1 }, (v) => s.contador = v),
    HStack({ spacing: 12 }, [
      Button('Restar', () => s.contador--).style('glass'),
      Button({ title: 'Sumar', systemImage: 'plus' }, () => s.contador++).style('glassProminent'),
    ]),
    s.wifi ? Label('Conectado', 'wifi') : null,
  ]).padding(24).glassEffect({ shape: 'rect', cornerRadius: 28 }).padding()
);
await ui.present({ title: 'Ejemplo', background: UI.gradient(['indigo', 'teal']) });
```

- `UI.view(estado, render)` devuelve la vista. `render(s)` se llama de nuevo cada vez que cambia algo en `s`, ya sea desde un control, un temporizador o después de un `await`.
- `await ui.present({ title, fullscreen, background })` la muestra y termina cuando se cierra. `background` acepta un color, `UI.gradient([...])` o un material.
- `ui.state` es el estado (cámbialo desde fuera, por ejemplo al terminar un `fetch`). `ui.update()` redibuja a mano y `ui.close()` cierra la vista.
- Los hijos `null`, `false` o `undefined` no se dibujan, así que puedes escribir `condición ? Vista : null`. Un texto suelto se convierte en `Text`. Los arrays (por ejemplo de un `.map`) se aplanan.

Los componentes son globales y también están en `UI` (`UI.Text`, `UI.Button`…). `Image` y `DatePicker` solo están como `UI.Image` y `UI.DatePicker`, porque esos nombres ya son clases de Scriptable.

| Componente | Uso |
|---|---|
| `VStack`, `HStack`, `ZStack` | `VStack({ spacing, alignment }?, [hijos])`. Apilan en vertical, horizontal o encima. |
| `ScrollView` | `ScrollView({ axis: 'horizontal', spacing }?, [hijos])`. Contenido que se desplaza. |
| `List`, `Form`, `Section` | Listas y formularios de iOS. `Section('Título', [...])` o `Section({ header, footer }, [...])`. |
| `GlassEffectContainer` | `GlassEffectContainer({ spacing, axis: 'vertical' }?, [hijos])`. Une el vidrio de sus hijos al acercarse (iOS 26). Por defecto los pone en fila. |
| `Text`, `Label` | `Text('hola')`, `Label('Ajustes', 'gear')`. |
| `UI.Image` | `UI.Image('star.fill')` para un símbolo SF; `UI.Image(imagen)` o una ruta para un archivo. Añade `.resizable()` para que llene su `frame`. |
| `Button` | `Button('Título', fn)` o `Button({ title, systemImage, role: 'destructive' }, fn)`. |
| `Menu` | `Menu('Más' \| { title, systemImage }, [Button…])`. |
| `Toggle` | `Toggle('Título', valor, (v) => …)`. |
| `Slider` | `Slider(valor, { min, max, step }, (v) => …)`. Sin opciones va de 0 a 1. |
| `Stepper` | `Stepper('Cantidad: ' + n, n, { min, max, step }, (v) => …)`. |
| `Picker` | `Picker('Título', seleccionado, opciones, (valor) => …)`. Las opciones son valores o `{ label, value, systemImage }`. |
| `TextField`, `SecureField` | `TextField('Placeholder', texto, (t) => …, { onSubmit, keyboard, multiline })`. `keyboard`: `number`, `decimal`, `email`, `url`, `phone`. |
| `UI.DatePicker` | `UI.DatePicker('Fecha', fecha, (d) => …, { mode: 'date' \| 'time' \| 'dateTime', min, max })`. |
| `ProgressView` | `ProgressView()` gira; `ProgressView(valor, { total, label })` se llena. |
| `Spacer`, `Divider` | Espacio flexible y línea separadora. |
| `Rectangle`, `RoundedRectangle(r)`, `Circle`, `Capsule` | Formas. Se rellenan con `.fill(color \| degradado \| material)`. |
| `WebContent` | `WebContent(webView)`. Muestra un `WebView` dentro de la vista, con controles nativos alrededor o encima (ver abajo). |

Modificadores (se encadenan y se aplican en orden, como en SwiftUI):

| Modificador | Descripción |
|---|---|
| `.glassEffect({ tint, interactive, clear, shape, cornerRadius })` | Liquid Glass detrás de la vista. `shape`: `'capsule'` (por defecto), `'circle'` o `'rect'`. `interactive` hace que reaccione al tocarlo. Antes de iOS 26 se usa un material translúcido. |
| `.style(nombre)` | Estilo de los controles de dentro. Botones: `glass`, `glassProminent`, `bordered`, `borderedProminent`, `borderless`, `plain`. Picker: `segmented`, `menu`, `wheel`, `inline`. Toggle: `switch`, `button`. TextField: `roundedBorder`, `plain`. DatePicker: `compact`, `graphical`, `wheel`. ProgressView: `linear`, `circular`. List y Form: `insetGrouped`, `grouped`, `inset`, `plain`, `sidebar`. Aplicado a un stack, afecta a todos sus controles. |
| `.padding(n \| { top, bottom, leading, trailing, horizontal, vertical })` | Margen. Sin argumento usa el del sistema. |
| `.frame({ width, height, minWidth, maxWidth, minHeight, maxHeight, alignment })` | Tamaño. `maxWidth: Infinity` ocupa todo el ancho. |
| `.font(estilo \| Font \| { size, weight, design })`, `.fontWeight(peso)` | Estilos: `largeTitle`, `title`, `title2`, `title3`, `headline`, `subheadline`, `body`, `callout`, `footnote`, `caption`, `caption2`. |
| `.foregroundStyle(c)`, `.tint(c)`, `.background(c, radio?)` | Colores: nombres (`'red'`, `'blue'`, `'secondary'`, `'accent'`…), `'#RRGGBB'`, `Color`, `UI.gradient([...], inicio?, fin?)` o materiales (`'thinMaterial'`, `'regularMaterial'`…). |
| `.cornerRadius(r)`, `.shadow(r, { color, x, y })`, `.opacity(x)` | Esquinas, sombra y transparencia. |
| `.disabled()`, `.controlSize('small' \| 'large' \| …)`, `.lineLimit(n)`, `.multilineTextAlignment('center')` | Desactivar, tamaño de los controles y texto. |
| `.onTapGesture(fn)` | Toque sobre cualquier vista. |
| `.ignoresSafeArea()`, `.scrollContentBackground('hidden')`, `.aspectRatio('fit' \| 'fill')`, `.id(clave)` | Ocupar toda la pantalla, quitar el fondo de una `List` para ver el de detrás, encajar imágenes y dar una clave estable a elementos de una lista que cambian de orden. |

#### Combinar un `WebView` con controles nativos

Si un script ya dibuja su contenido en HTML (un visor de fotos, vídeos o stories), no hace falta rehacerlo. Mete el `WebView` en la vista con `WebContent(webView)` y pon encima la barra, los botones y los menús nativos con Liquid Glass. El HTML queda para el contenido y la interfaz es nativa.

La comunicación va en los dos sentidos:

- **Del script a la página:** `await webView.evaluateJavaScript('mostrar(3)')`, como siempre.
- **De la página al script:** la página llama a `sendToScript(valor)` y el script lo recibe en `webView.onMessage = (valor) => …`. El valor puede ser un texto, un número o un objeto.

```js
const visor = new WebView();
await visor.loadHTML(`
  <body style="margin:0;background:#000">
    <img id="foto" src="https://picsum.photos/800/1400" style="width:100%;height:100vh;object-fit:cover"
         onclick="sendToScript({ tipo: 'toque', x: event.clientX })">
    <script>function siguiente() { foto.src = 'https://picsum.photos/800/1400?' + Date.now(); }</script>
  </body>`);

const ui = UI.view({ toques: 0 }, (s) =>
  ZStack({ alignment: 'top' }, [
    WebContent(visor).ignoresSafeArea(),
    HStack([
      Button({ systemImage: 'xmark' }, () => ui.close()).style('glass'),
      Spacer(),
      Text(`${s.toques} toques`).padding({ horizontal: 14, vertical: 8 }).glassEffect(),
      Button({ systemImage: 'forward.fill' }, () => visor.evaluateJavaScript('siguiente()')).style('glass'),
    ]).padding(),
  ])
);
visor.onMessage = (m) => { if (m.tipo === 'toque') ui.state.toques++; };
await ui.present({ fullscreen: true });
```

Con `fullscreen: true` la vista ocupa toda la pantalla sin barra del sistema. Para salir hay que poner un botón que llame a `ui.close()`, como en el ejemplo, o agitar el iPhone.

Si el mismo `WebView` está a la vez en un `WebContent` y abierto con `present()`, se ve solo en uno de los dos sitios. Usa una cosa u otra.

El vidrio luce sobre colores o imágenes. Sobre un fondo blanco liso apenas se nota, así que dale a la vista un `background`. Con `List` o `Form`, añade `.scrollContentBackground('hidden')` para que se vea.

Un ajuste con formulario:

```js
const ui = UI.view({ nombre: '', avisos: true, tema: 'auto' }, (s) =>
  Form([
    Section('Perfil', [
      TextField('Nombre', s.nombre, (t) => s.nombre = t, { onSubmit: () => console.log('Hola', s.nombre) }),
    ]),
    Section({ header: 'Preferencias', footer: 'Se guardan al cerrar.' }, [
      Toggle('Avisos', s.avisos, (v) => s.avisos = v),
      Picker('Tema', s.tema, [{ label: 'Automático', value: 'auto' }, 'claro', 'oscuro'], (v) => s.tema = v).style('segmented'),
    ]),
    Section([Button({ title: 'Cerrar', role: 'cancel' }, () => ui.close())]),
  ])
);
await ui.present({ title: 'Ajustes' });
FS.writeJSON('ajustes.json', ui.state);
```

Para tablas al estilo de Scriptable están `UITable`, `WebView` y `ListWidget` (ver [Compatibilidad](#13-compatibilidad-con-scriptable)).

---

## 12. Portapapeles, notificaciones, dispositivo y llavero

### `Pasteboard`

| Función | Descripción |
|---|---|
| `Pasteboard.text` | Lee o asigna el texto del portapapeles. |
| `Pasteboard.copy(texto)` / `Pasteboard.paste()` | Lo mismo, como funciones. |
| `Pasteboard.copyFile(ruta)` | Copia un archivo de cualquier tipo, vídeos incluidos. |
| `Pasteboard.pasteFile(destino?)` | Guarda en disco el primer contenido que no sea texto. Devuelve `{ path, type }`, o `null`. |

### `Notify`

`await Notify.schedule(opciones)` programa una notificación local y devuelve su id. La primera vez iOS pide permiso.

| Opción | Descripción |
|---|---|
| `title`, `subtitle`, `body` | Textos. |
| `in` | Segundos desde ahora. |
| `at` | Momento exacto como **número en ms**: `fecha.getTime()`, no un `Date`. |
| `attachment` | Ruta de una imagen o un vídeo para adjuntar. |
| `id` | Id propio, útil para reemplazarla o cancelarla. |
| `sound` | `false` o `'none'` para silenciarla. |
| `badge`, `threadIdentifier`, `userInfo` | Como en iOS. |

Sin `in` ni `at` se muestra al momento. `Notify.cancel(id)` la cancela si está pendiente y la quita si ya se mostró.

```js
await Notify.schedule({ title: 'Descanso', body: 'Levántate un rato', in: 25 * 60 });
```

### `Device`

`Device.info()` devuelve:

| Campo | Contenido |
|---|---|
| `name`, `model`, `systemName`, `systemVersion` | Datos del dispositivo. |
| `idiom` | `'phone'` o `'pad'`. |
| `battery`, `batteryState` | Nivel de 0 a 1 y `'unplugged'`, `'charging'`, `'full'` o `'unknown'`. |
| `lowPowerMode`, `darkMode` | `true` o `false`. |
| `screen`, `brightness`, `orientation` | `{ width, height, scale }` en puntos, brillo de 0 a 1 y orientación (1 vertical, 2 invertida, 3-4 horizontal, 5-6 boca arriba/abajo). |
| `locale`, `languages`, `timeZone` | Región, idiomas preferidos y zona horaria. |
| `memory`, `freeDisk`, `totalDisk` | En bytes. |
| `volume` | Volumen de salida de 0 a 1. |

`Device.setBrightness(0..1)` cambia el brillo. También existen las funciones de Scriptable: `Device.batteryLevel()`, `Device.isCharging()`, `Device.isUsingDarkAppearance()`, `Device.screenSize()`, `Device.language()`…

### `Keychain`

Guarda secretos (tokens, claves de API) cifrados en el llavero de iOS. Persisten entre ejecuciones y son comunes a todos los scripts.

| Función | Descripción |
|---|---|
| `Keychain.set(clave, valor)` | Guarda como texto. |
| `Keychain.get(clave)` | Devuelve el valor. **Lanza un error** si la clave no existe. |
| `Keychain.contains(clave)` | `true` o `false`. |
| `Keychain.remove(clave)` | Borra. |

```js
if (!Keychain.contains('token')) {
  const token = await prompt('Pega tu token de API');
  if (!token) return;
  Keychain.set('token', token);
}
const token = Keychain.get('token');
```

---

## 13. Compatibilidad con Scriptable

Los scripts escritos para Scriptable funcionan sin cambios: las clases de [docs.scriptable.app](https://docs.scriptable.app) están implementadas con los mismos nombres y argumentos. Su documentación oficial sirve como referencia; aquí solo se resume qué hay y en qué se diferencia.

| Área | Clases |
|---|---|
| Archivos y datos | `FileManager`, `Data`, `Image`, `DocumentPicker` |
| Red | `Request` (con multipart, `onRedirect` y `response`), `CallbackURL` |
| Interfaz | `Alert`, `UITable`/`UITableRow`/`UITableCell`, `WebView`, `QuickLook`, `ShareSheet`, `Safari`, `DatePicker` |
| Dibujo y widgets | `DrawContext`, `Path`, `Point`, `Size`, `Rect`, `Color`, `Font`, `LinearGradient`, `SFSymbol`, `ListWidget`, `WidgetStack`… |
| Sistema | `Location`, `Notification`, `Pasteboard`, `Keychain`, `Device`, `Dictation`, `Timer`, `UUID`, `Mail`, `Message` |
| Calendario y contactos | `Calendar`, `CalendarEvent`, `Reminder`, `RecurrenceRule`, `Contact`, `ContactsContainer`, `ContactsGroup` |
| Formato | `DateFormatter`, `RelativeDateTimeFormatter`, `XMLParser` |

### Diferencias

- **Widgets.** `presentSmall()`, `presentMedium()`, `presentLarge()` y similares muestran una vista previa, pero Scriptor no instala widgets en la pantalla de inicio. `Script.setWidget()` no hace nada.
- **iCloud.** `FileManager.iCloud()` usa la carpeta local, porque las cuentas gratuitas no tienen iCloud. `downloadFileFromiCloud()` no hace nada.
- **Pantalla completa.** Las tablas y webs presentadas a pantalla completa se cierran agitando el iPhone.
- **Contactos.** Las notas de los contactos no están disponibles (`isNoteAvailable` es `false`): requieren un permiso que las apps instaladas por sideload no pueden tener.
- **Etiquetas de archivo.** `addTag()` y `removeTag()` no hacen nada y `allTags()` devuelve un array vacío.
- **`Notification.current()`** devuelve `null`.

### Extras de Scriptor sobre las clases de Scriptable

- `image.path`: la ruta del archivo que hay detrás de un `Image`. Cualquier `Image` se puede pasar donde se pida una ruta (`Photos.save`, `UI.share`…).
- `Image.resize`, `Image.crop`, `Image.convert` e `Image.info` (ver [Imagen](#imagen)).
- `Location.geocode(dirección, locale?)`: de una dirección a lugares con coordenadas.
- `Data.fromBytes(bytes)`, `data.bytes` y `data.length`.
- `webView.onMessage = (valor) => …` y `sendToScript(valor)` en la página: la página avisa al script sin trucos de URLs. También `WebContent(webView)` para meter el `WebView` dentro de un `UI.view`.
- `table.glass = true`: cada fila de un `UITable` se muestra como una tarjeta de Liquid Glass sobre un fondo agrupado. Las filas con `isHeader` quedan como títulos sin tarjeta, el `backgroundColor` de una fila tiñe el vidrio y las filas con `onSelect` reaccionan al tocarlas. En versiones anteriores a iOS 26 se usa un desenfoque translúcido. En Scriptable la propiedad se ignora y la tabla se ve normal.

```js
const table = new UITable();
table.glass = true;
const header = new UITableRow();
header.isHeader = true;
header.addText('Ajustes');
table.addRow(header);
const row = new UITableRow();
row.addText('Notificaciones', 'Activadas');
row.onSelect = () => console.log('tocada');
table.addRow(row);
await table.present();
```

### Mezclar ambos estilos

Puedes usar las dos APIs en el mismo script. Las de Scriptor suelen ser más cortas y no cargan los archivos en memoria:

| Scriptable | Scriptor |
|---|---|
| `FileManager.local().readString(path)` | `FS.readText(path)` |
| `await new Request(url).loadJSON()` | `await (await fetch(url)).json()` |
| `Photos.fromLibrary()` | `Photos.pick()` |
| `new Alert()` + `addAction` + `presentAlert()` | `UI.alert(título, mensaje, { buttons })` |
| `Timer.schedule(ms, repite, fn)` | `setTimeout` / `setInterval` |

---

## 14. Errores frecuentes

| Problema | Causa y solución |
|---|---|
| El diálogo no aparece o el script sigue sin esperar | Falta `await` delante de `alert`, `prompt`, `UI.alert`… |
| El script no termina nunca | Queda un `setInterval` o un `WebSocket` abierto. Cancélalo o usa `Script.complete()`. |
| `Keychain.get` lanza un error | La clave no existe. Comprueba antes con `Keychain.contains`. |
| La notificación sale al momento | `at` recibió un `Date`. Pásale `fecha.getTime()`. |
| `btoa: character out of range` | El texto tiene acentos o emojis. Usa `Base64.encode(texto)`. |
| `Unsupported body type` en `fetch` | Pasaste un objeto como `body`. Usa `JSON.stringify(objeto)`. |
| `fetch` no lanza error con un 404 | Es lo estándar. Comprueba `res.ok` o `res.status`. |
| No encuentro el archivo que creé | Si no indicaste destino, está en la carpeta temporal: usa la ruta que devuelve la función o guárdalo con `FS.move`. |
| `Cannot find module 'x'` | El módulo debe estar en `Documents/modules/` o `Documents/`, o usar una ruta relativa. |
| `Photo library access denied` | Concede el permiso en *Ajustes › Scriptor › Fotos*. |
| Un `UI.view` no cambia al modificar el estado | Cambiar `s.x = …` redibuja, pero modificar algo *dentro* de un objeto o array (`s.lista.push(x)`) fuera de un control no se detecta. Llama a `ui.update()` después, o asigna de nuevo: `s.lista = [...s.lista, x]`. |
| Un control vuelve a su valor anterior | Su función no actualiza el estado: `Toggle('Wi-Fi', s.wifi, (v) => s.wifi = v)`. Sin esa asignación la vista sigue dibujando el valor viejo. |
| El vidrio de `glassEffect` apenas se ve | Sobre fondo blanco liso casi no se nota. Pon un `background` en `present()` o detrás de la vista, y en `List`/`Form` añade `.scrollContentBackground('hidden')`. |
| Una miniapp muestra `[object Promise]` o un valor vacío | En las miniapps toda la API de Scriptor es asíncrona: `await FS.readText(p)`. |
| `<div> no es un componente` en una miniapp | Usa los componentes (`<VStack>`, `<Text>`…). Para HTML, ponlo en un `<WebView html={…}>`. |
| Un control de `UI.view` arrastra a otra vista con retraso | Los cambios ya se dibujan sin animación. Si la pantalla debe seguir al dedo con fluidez, hazla como miniapp `.jsx`, que corre dentro de la app. |
| Un vídeo sale en negro o no abre con `UI.preview` | iOS no sabe decodificarlo (AV1 en iPhone anteriores al 15 Pro, MKV, WebM). Ábrelo con `Video.play(ruta)`. |

---

## 15. Recetas

### Guardar un vídeo de internet en el carrete

```js
const url = await prompt('URL del vídeo');
if (!url) return;
const { path } = await Net.download(url, {
  onProgress: (e) => e.total > 0 && console.log(Math.round((e.loaded / e.total) * 100) + '%'),
});
await Photos.save(path);
UI.haptic('success');
return 'Guardado';
```

### Reducir las últimas fotos y compartirlas

```js
const fotos = await Photos.latest({ type: 'image', limit: 5 });
const rutas = [];
for (const foto of fotos) {
  const original = await Photos.export(foto.id);
  rutas.push(await Image.resize(original, { width: 1280, format: 'jpeg', quality: 0.8 }));
}
await UI.share(rutas);
```

### Llamar a una API con un token guardado y cachear la respuesta

```js
const CACHE = FS.join(FS.cache, 'tiempo.json');
const UNA_HORA = 60 * 60 * 1000;

let datos;
if (FS.exists(CACHE) && Date.now() - FS.stat(CACHE).modified < UNA_HORA) {
  datos = FS.readJSON(CACHE);
} else {
  const res = await fetch('https://api.example.com/tiempo?ciudad=Madrid', {
    headers: { Authorization: 'Bearer ' + Keychain.get('token') },
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  datos = await res.json();
  FS.writeJSON(CACHE, datos);
}
return datos;
```

### Menú con varias acciones

```js
const opciones = ['Copiar fecha', 'Ver batería', 'Abrir Atajos'];
switch (await UI.menu('¿Qué hago?', opciones)) {
  case 0: Pasteboard.copy(new Date().toLocaleDateString('es-ES')); break;
  case 1: await alert(Math.round(Device.info().battery * 100) + '%'); break;
  case 2: await UI.open('shortcuts://'); break;
  default: return 'Cancelado';
}
```

### Registro diario en un archivo

```js
const nota = await prompt('¿Qué has hecho hoy?');
if (nota) FS.appendText('diario.txt', `${new Date().toISOString().slice(0, 10)}  ${nota}\n`);
```

---

### Lista de tareas con `UI.view`

```js
const ui = UI.view({ tareas: FS.exists('tareas.json') ? FS.readJSON('tareas.json') : [], nueva: '' }, (s) =>
  List([
    Section('Nueva', [
      HStack([
        TextField('Escribe una tarea', s.nueva, (t) => s.nueva = t, {
          onSubmit: () => { if (s.nueva) { s.tareas = [...s.tareas, { texto: s.nueva, hecha: false }]; s.nueva = ''; } },
        }),
      ]),
    ]),
    Section(`${s.tareas.filter((t) => !t.hecha).length} pendientes`, s.tareas.map((t, i) =>
      Toggle(t.texto, t.hecha, (v) => { s.tareas[i].hecha = v; })
    )),
  ])
);
await ui.present({ title: 'Tareas' });
FS.writeJSON('tareas.json', ui.state.tareas);
```

### Ver un vídeo AV1 descargado

```js
const { path } = await Net.download('https://example.com/clip-av1.mp4');
const r = await Video.play(path);
console.log(r.ended ? 'Visto entero' : `Parado en ${Math.round(r.position)} s de ${Math.round(r.duration)} s`);
```

## 16. Miniapps (`.jsx` y `.tsx`)

Además de scripts `.js`, Scriptor ejecuta **miniapps**: archivos `.jsx` o `.tsx` escritos con React. Se dibujan con las vistas de SwiftUI (las mismas de `UI.view`) y Liquid Glass. A diferencia de `UI.view`, corren dentro de la app, así que la interfaz responde al momento: un botón que sigue al dedo o a un deslizador se mueve en el mismo fotograma.

| | Script `.js` | Miniapp `.jsx` / `.tsx` |
|---|---|---|
| Para qué | Automatizar: descargar, convertir, procesar fotos, atajos | Pantallas interactivas que se quedan abiertas |
| Interfaz | `alert`, `UITable`, `UI.view`, `WebView` | Componentes React (`<VStack>`, `<Button>`…) y `<WebView>` |
| Llamadas a la API | Síncronas cuando se puede (`FS.readText(p)`) | Siempre con `await` (`await FS.readText(p)`) |
| Termina | Cuando acaba su código | Cuando la cierras (agitar › Cerrar miniapp, o `close()`) |

### Crear una

Pulsa **+ › Nueva miniapp**. El archivo se crea con un ejemplo que funciona, y ▶︎ lo abre a pantalla completa. También puedes copiar archivos `.jsx` o `.tsx` a la carpeta de Scriptor desde Archivos. En la rejilla, cada archivo lleva una etiqueta con su tipo: **JS**, **JSX**, **TSX** o **PY**.

Una miniapp exporta un componente por defecto:

```jsx
// icon-color: teal; icon-glyph: magic;
export default function App() {
  const [nombre, setNombre] = useState('');
  const [veces, setVeces] = useStored('veces', 0);

  return (
    <Page>
      <Text style="largeTitle" weight="bold">Hola{nombre ? ', ' + nombre : ''}</Text>
      <TextField value={nombre} onChange={setNombre} placeholder="Tu nombre" />
      <Card glass>
        <Row label="Veces pulsado" value={veces} />
        <Button title="Pulsar" icon="hand.tap" style="prominent" onPress={() => setVeces(veces + 1)} />
      </Card>
    </Page>
  );
}
```

- La cabecera `// icon-color: …; icon-glyph: …;` y el primer comentario funcionan igual que en los scripts.
- En los `.tsx` puedes usar tipos de TypeScript; se quitan al ejecutar.
- No hace falta importar nada: React, los componentes y la API ya están disponibles. Si prefieres importarlos, `import { useState } from 'react'` y `import { FS } from 'scriptor'` también funcionan.

### Salir y menú

Al abrirse, un aviso recuerda que hay que **agitar el iPhone** para ver el menú: Reiniciar, Editar, Consola y Cerrar miniapp. Desde el código, `close()` la cierra.

Si la miniapp lanza un error (al dibujar, en un `onPress` o en una promesa sin capturar), la pantalla muestra el mensaje con su línea y botones para editar, reintentar o cerrar. Un bucle que no deja dibujar durante más de 3 segundos se detiene con un error en su línea.

### Lo que tiene a mano

| Nombre | Qué es |
|---|---|
| `useState`, `useEffect`, `useMemo`, `useRef`, `useCallback`, `useReducer`, `useContext` | Los hooks de React |
| `useStored(clave, inicial)` | Como `useState`, pero el valor se guarda y sigue ahí la próxima vez |
| `useLocation`, `useHeading`, `useAccelerometer`, `useGyroscope`, `useBarometer`, `useAppState` | Hooks que siguen al iPhone mientras la miniapp está abierta: ver [Sensores y ubicación](#sensores-y-ubicación) |
| `storage.get(clave, porDefecto)` / `set` / `remove` / `keys` / `clear` | Los mismos datos guardados, sin hook |
| `FS`, `Net`, `Photos`, `Camera`, `Video`, `Audio`, `Speech`, `Pasteboard`, `Notify`, `Device`, `Keychain`, `Crypto`, `Location`, `Calendar`, `Contacts`, `Safari`, `Mail`, `Message`, `ShareSheet`, `QuickLook`, `Dictation`, `DocumentPicker`, `UI`, `Script` | La API de Scriptor de las secciones anteriores. Cada llamada devuelve una promesa |
| `Scriptor` | Cualquier otra función global de Scriptor: `await Scriptor.Image.resize(ruta, { width: 400 })` |
| `alert(mensaje, título?)`, `confirm(…)`, `prompt(mensaje, valor?, título?)` | Diálogos, como en los scripts |
| `haptic(tipo?)` | Vibración: `'light'`, `'medium'`, `'heavy'`, `'success'`, `'warning'`, `'error'`, `'selection'` |
| `input` | Los parámetros de `scriptor://app/Archivo.jsx?clave=valor` |
| `console.log` / `warn` / `error` | Se ven en *agitar › Consola* |
| `setTimeout`, `setInterval` | Se paran solos al cerrar la miniapp |
| `fetch` | El de React Native; no pasa por Scriptor |
| `close()` | Cierra la miniapp |
| `SwiftUI`, `modifiers` | Las vistas y modificadores de `@expo/ui/swift-ui` sin adaptar, para lo que no cubren los componentes |

Diferencias con los scripts al llamar a la API:

- **Todo con `await`:** `const texto = await FS.readText('notas.txt')`.
- **Las propiedades se leen llamándolas:** `await FS.documents()`, `await Pasteboard.text()`.
- **Los callbacks funcionan:** `await Net.download(url, 'v.mp4', { onProgress: (p) => setProgreso(p.loaded / p.total) })`.
- **Bytes y fechas llegan como tales:** `FS.readBytes` devuelve un `Uint8Array` y un `Date` llega como `Date`.
- **Las clases con métodos no:** `new Request(…)`, `new WebView()`, `UITable` o `UI.view` solo existen en los scripts. En una miniapp usa `fetch`, `<WebView>` y los componentes.
- **Las fotos y archivos se muestran por ruta:** `const [foto] = await Photos.pick()` y luego `<Image path={foto.path} />`.

### Componentes

Todos aceptan estas propiedades comunes:

| Propiedad | Efecto |
|---|---|
| `padding` | Número o `{ top, bottom, leading, trailing, horizontal, vertical }` |
| `width`, `height`, `minHeight`, `maxWidth`, `maxHeight` | Tamaño. `maxWidth={Infinity}` ocupa todo el ancho |
| `fill` | Todo el ancho, con el contenido a la izquierda |
| `frameAlignment` | Dónde queda el contenido en su marco: `'center'`, `'leading'`, `'topTrailing'`… |
| `background` | Color de fondo |
| `radius` | Esquinas redondeadas |
| `glass` | Liquid Glass detrás: `true`, `'clear'` o `{ variant, tint, interactive, shape }`. Antes de iOS 26, un material translúcido |
| `opacity`, `disabled` | Transparencia y desactivar |
| `x`, `y`, `scale`, `rotation` | Mover, escalar o girar (en grados) sin cambiar el diseño |
| `animation`, `animateOn` | Anima esos cambios cada vez que cambia `animateOn`: `animation="bouncy" animateOn={abierto}`. Sin `animateOn` nada se anima, así que lo que sigue al dedo va pegado a él |
| `onTap`, `onLongPress` | Toque y pulsación larga en cualquier vista |
| `onTapAt`, `onDoubleTap`, `onHold`, `onSwipe`, `onDrag`, `zoom` | Gestos: ver [Gestos](#gestos) |
| `rotation3D` | Giro en 3D en grados (eje `y` por defecto) o `{ angle, axis, anchor, perspective }`, para voltear tarjetas o un cubo entre páginas |
| `modifiers` | Modificadores de SwiftUI sin adaptar: `modifiers={[modifiers.blur(4)]}` |

Colores: `'accent'` (el color de la miniapp), `'primary'`, `'secondary'`, `'tertiary'`, `'danger'`, `'surface'`, `'background'`, los nombres de los colores de Scriptor (`'orange'`, `'deep-purple'`…) o cualquier color CSS (`'#FF8800'`, `'rgba(0,0,0,0.4)'`).

| Componente | Propiedades propias |
|---|---|
| `<Text>` | `style` (`'largeTitle'`, `'title'`, `'headline'`, `'body'`, `'footnote'`, `'caption'`…), `size`, `weight`, `design`, `color`, `mono`, `align`, `lines`, `selectable` |
| `<VStack>`, `<HStack>`, `<ZStack>` | `spacing`, `alignment` |
| `<GlassGroup>` | `spacing`. Las vistas con `glass` de dentro se funden y se separan al moverse (iOS 26) |
| `<Page>` | Columna desplazable con márgenes de página; `spacing`, `alignment` |
| `<List>` y `<Section title footer>` | Lista agrupada de iOS, como Ajustes |
| `<Card>` | Superficie redondeada; con `glass` es de vidrio |
| `<Row label value icon color onPress>` | Etiqueta y valor en una línea; con `onPress` se puede tocar |
| `<Button title icon style color onPress>` | `style`: `'prominent'`, `'glass'`, `'bordered'`, `'plain'`, `'destructive'` |
| `<IconButton icon label prominent color onPress>` | Botón redondo de vidrio, solo con icono |
| `<Image symbol size color>` / `<Image path mode>` | Símbolo de SF Symbols, o imagen de un archivo (`mode`: `'fit'` o `'fill'`) |
| `<Image url headers mode ratio placeholder onLoad onError>` | Imagen de internet, guardada en disco (ver [Imágenes y vídeo de internet](#imágenes-y-vídeo-de-internet)) |
| `<Video url headers playing muted loop controls mode ratio rate ref>` | Vídeo dentro de la pantalla (ver abajo) |
| `<Toggle label icon value onChange>` | Interruptor |
| `<Slider value min max step onChange>` | Deslizador |
| `<Stepper label value min max step onChange>` | Contador con − y + |
| `<TextField value onChange onSubmit placeholder multiline lines keyboard autocorrect plain>` | Campo de texto. `keyboard`: `'number'`, `'decimal'`, `'email'`, `'url'`, `'phone'` |
| `<Picker value onChange options label style>` | `options`: valores o `{ label, value }`. `style`: `'menu'`, `'segmented'`, `'wheel'`, `'inline'` |
| `<Progress value color>` | Barra de 0 a 1; sin `value`, un indicador de carga |
| `<Empty title icon detail>` | Estado vacío de iOS |
| `<Spacer>`, `<Divider>` | Espacio flexible y separador |
| `<WebView url html baseURL onMessage onLoad inject ref>` | Una página web entre las vistas nativas (ver abajo) |

### Imágenes y vídeo de internet

`<Image url>` descarga la imagen una vez y la guarda en el iPhone (hasta 500 MB; se borran primero las que llevan más tiempo sin usarse). En pantalla se decodifica al tamaño en que se dibuja, así que una cuadrícula de cientos de fotos no llena la memoria.

```jsx
<Image url={post.thumbnail} headers={{ Referer: 'https://example.com/' }} mode="fill" ratio={1} radius={4} />
<Image url={perfil.foto} width={88} height={88} mode="fill" radius={44} />
<Image url={foto.url} fill onLoad={({ width, height }) => console.log(width, height)} />
```

- `mode="fit"` (por defecto) muestra la imagen entera. Sin `ratio` ni tamaño, toma sus propias proporciones al cargarse, como una imagen web con ancho 100 %.
- `mode="fill"` cubre el marco y recorta lo que sobra. Necesita un tamaño: `width`/`height`, o `ratio` con el ancho del padre.
- `headers` va en la petición: `Referer`, `Cookie`, `User-Agent`…
- Mientras carga se ve un fondo gris suave, o el color de `placeholder`. Al llegar, aparece con un fundido.
- `prefetchImages(urls, headers)` descarga por adelantado (las siguientes stories, por ejemplo) sin dibujarlas.

`<Video>` reproduce dentro de la pantalla, con `AVPlayer`. Sirve un vídeo de internet (MP4 o HLS, con `headers`) o un archivo (`'Descargas/v.mp4'`).

```jsx
const video = useRef(null);
const [playing, setPlaying] = useState(true);
const [time, setTime] = useState({ now: 0, total: 0 });

<ZStack>
  <Video ref={video} url={reel.video} headers={HEADERS} playing={playing} muted={muted} loop mode="fill" ratio={9 / 16}
    onProgress={(now, total) => setTime({ now, total })} onEnd={siguiente} />
  <HStack padding={16} spacing={12} frameAlignment="bottom" fill>
    <IconButton icon={playing ? 'pause.fill' : 'play.fill'} onPress={() => setPlaying(!playing)} />
    <IconButton icon="gobackward.5" onPress={() => video.current.seek(Math.max(0, time.now - 5))} />
    <Progress value={time.total ? time.now / time.total : 0} fill />
  </HStack>
</ZStack>
```

- `playing` (por defecto `true`) y `muted` lo controlan. Al salir de la pantalla se pausa solo.
- `loop` vuelve a empezar al terminar; si no, se llama a `onEnd`.
- `controls` muestra los controles del sistema (barra, AirPlay, pantalla completa). Sin ellos, dibujas los tuyos encima.
- `mode`: `'fit'` o `'fill'`. Sin `width`, `height` ni `ratio`, ocupa el espacio que le dan.
- `rate` es la velocidad (1 = normal); `ref.current.seek(segundos)` salta.
- Eventos: `onReady({ duration, width, height })`, `onProgress(segundo, duración)` cuatro veces por segundo, `onBuffering(true/false)`, `onEnd()` y `onError(mensaje)`.
- Cada `<Video>` es un reproductor: ten pocos a la vez. En un visor de stories, uno para la actual y quizá otro para la siguiente con `playing={false}`, que se va cargando.

### Gestos

Funcionan en cualquier vista, igual que `onTap`. Todos son de SwiftUI: la vista sigue al dedo sin esperar a tu código.

| Propiedad | Qué hace |
|---|---|
| `onTapAt={(e) => …}` | Toque con su posición: `{ x, y, width, height }`. Para saber si fue en el tercio izquierdo o derecho |
| `onDoubleTap` | Doble toque. Si la vista también tiene `onTap`, el toque simple espera un momento por si llega el segundo |
| `onHold={(pulsando) => …}` | `true` al apoyar el dedo, `false` al soltarlo: mantener para pausar |
| `onSwipe={(dir) => …}` | Deslizamiento rápido: `'left'`, `'right'`, `'up'` o `'down'`. No impide desplazar una lista |
| `onDrag={(e) => …}` + `drag={{ axis, follow, live }}` | La vista sigue al dedo (en `axis`: `'x'`, `'y'` o `'both'`) y vuelve con un muelle al soltar. `e.phase` es `'start'`, `'change'` (solo con `live: true`) o `'end'`; trae `translation`, `predicted` (hacia dónde iba con el impulso) y `location` |
| `zoom` | Pellizcar para ampliar, mover mientras está ampliado y doble toque. `zoom={{ mode: 'peek' }}` vuelve a su tamaño al soltar, como una foto del feed. También `maxScale` (4) y `onZoom(escala)` |

Un visor de stories, por ejemplo:

```jsx
<ZStack
  onTapAt={({ x, width }) => (x < width / 3 ? anterior() : siguiente())}
  onHold={(pulsando) => setPausado(pulsando)}
  onDrag={({ phase, predicted }) => phase === 'end' && predicted.y > 200 && close()}
  drag={{ axis: 'y' }}
  rotation3D={giro} animation="smooth" animateOn={giro}>
  <Image url={story.imagen} mode="fill" fill height={800} />
</ZStack>
```

Para el giro de cubo entre cuentas, cambia `rotation3D` de `0` a `-90` (o `90`) con `animateOn`, y luego cambia de cuenta con `rotation3D` a `0`.

### Sensores y ubicación

Estos hooks leen el iPhone directamente, sin pasar por la API de Scriptor, así que no llevan `await`. Cada lectura nueva vuelve a dibujar la vista, y todo se para al cerrar la miniapp.

| Hook | Devuelve |
|---|---|
| `useLocation({ precise, distance })` | `{ location, error }`. `location` es `{ latitude, longitude, altitude, horizontalAccuracy, verticalAccuracy, speed, time }`, o `null` hasta la primera lectura. Se actualiza al moverte `distance` metros (10 por defecto). `precise: true` usa el GPS al máximo. Pide permiso la primera vez |
| `useHeading()` | Rumbo en grados desde el norte (0–360), o `null` |
| `useAccelerometer(ms)` | `{ x, y, z }` en g, cada `ms` milisegundos (100 por defecto), o `null` |
| `useGyroscope(ms)` | `{ x, y, z }` en radianes por segundo (100 ms por defecto) |
| `useBarometer(ms)` | `{ pressure, relativeAltitude }`: hPa y metros de subida desde que empezó (500 ms por defecto) |
| `useAppState(alCambiar?)` | `'active'`, `'inactive'` o `'background'`. `alCambiar` se llama en cada cambio, por ejemplo para guardar al salir |

```jsx
export default function App() {
  const { location, error } = useLocation({ distance: 5 });
  const rumbo = useHeading();
  const inclinacion = useAccelerometer(50);

  if (error) return <Empty title="Sin ubicación" icon="location.slash" detail={error} />;
  return (
    <Page>
      <Row label="Posición" value={location ? `${location.latitude.toFixed(5)}, ${location.longitude.toFixed(5)}` : '…'} />
      <Image symbol="location.north.fill" size={64} rotation={-(rumbo ?? 0)} />
      <Text mono>{inclinacion ? inclinacion.x.toFixed(2) : '–'}</Text>
    </Page>
  );
}
```

Para una sola lectura, `await Location.current()` sigue funcionando como en los scripts.

### Combinar un `WebView` con controles nativos

`<WebView>` muestra una página dentro de la miniapp y deja poner controles nativos y Liquid Glass encima o alrededor. La página llama a `window.sendToScript(valor)` y la miniapp lo recibe en `onMessage`. Con un `ref`, `web.current.run(js)` ejecuta código en la página, y `goBack()` y `reload()` navegan:

```jsx
export default function App() {
  const web = useRef(null);
  const [titulo, setTitulo] = useState('');

  return (
    <ZStack alignment="bottom" maxWidth={Infinity} maxHeight={Infinity}>
      <WebView
        ref={web}
        url="https://es.wikipedia.org"
        inject="window.addEventListener('load', () => sendToScript(document.title));"
        onMessage={setTitulo}
      />
      <HStack spacing={12} padding={{ horizontal: 16, vertical: 10 }} glass>
        <IconButton icon="chevron.left" label="Atrás" onPress={() => web.current.goBack()} />
        <Text lines={1} maxWidth={200}>{titulo}</Text>
        <IconButton icon="moon" label="Modo oscuro" prominent onPress={() => web.current.run("document.body.style.filter = 'invert(1) hue-rotate(180deg)'")} />
      </HStack>
    </ZStack>
  );
}
```

### Módulos e imports

- **Tus archivos:** los que empiezan por `_` son módulos. `import { formatear } from './_util'` busca `_util.js`, `_util.jsx` o `_util.tsx` en la carpeta de Scriptor.
- **Paquetes de npm:** `import dayjs from 'dayjs'` lo descarga de esm.sh (o de jsDelivr si esm.sh falla) la primera vez y lo guarda en `Library/miniapps/npm`, así que después funciona sin conexión. Hasta 3 MB por paquete.
- **De la app:** `'react'`, `'scriptor'`, `'@expo/ui/swift-ui'` y `'@expo/ui/swift-ui/modifiers'`.

Los datos de `useStored` y `storage` se guardan en `Library/miniapps/data/<archivo>.json`.

### Abrir desde fuera

`scriptor://app/Notas.jsx?nota=3` abre la miniapp desde Atajos o Safari, con `input.nota === '3'`.

## 17. Python (`.py`)

Los scripts `.py` se ejecutan como los `.js`: ▶︎ en la tarjeta o en el editor, la misma consola y el mismo botón de detener. Corren en [Pyodide](https://pyodide.org) (Python 3.13 compilado a WebAssembly) dentro de la app. Crea uno con **+ › Nuevo script Python**, o copia archivos `.py` a la carpeta de Scriptor desde Archivos. En la rejilla llevan la etiqueta **PY**.

```python
# icon-color: yellow; icon-glyph: code;
# Lee un CSV, lo resume con pandas y guarda el resultado.
import pandas as pd
import scriptor
from scriptor import alert

ruta = await scriptor.pull('datos/ventas.csv')
df = pd.read_csv(ruta)
print(df.describe())

df.groupby('mes').sum().to_csv('/home/pyodide/resumen.csv')
print('Guardado en', await scriptor.push('/home/pyodide/resumen.csv', 'datos/resumen.csv'))
await alert('Listo')
```

- **La primera vez** se descargan unos 12 MB (Python y su biblioteca estándar) y se guardan en el iPhone. Después arranca sin conexión. Python sigue cargado mientras la app está abierta, así que la segunda ejecución empieza al momento.
- **Paquetes.** Los `import` de paquetes de la distribución de Pyodide (numpy, pandas, matplotlib, scipy, scikit-learn, opencv, pillow…) se descargan solos la primera vez y quedan guardados. Los demás se instalan con `pip install` en la Terminal (abajo).
- **`await` en el nivel superior.** Como en JavaScript, puedes escribir `await` sin envolverlo en una función.
- **`print()`** sale en la consola, y lo que se escribe en `stderr` sale como aviso. **`input('pregunta')`** abre un diálogo con un campo de texto.
- **Cabecera y resumen.** La línea `# icon-color: …; icon-glyph: …;` guarda el color y el icono, y el primer comentario `# …` es el resumen de la tarjeta.
- **Uno a la vez.** Los scripts de Python se ejecutan de uno en uno: si lanzas otro, espera a que acabe el anterior. Detener un script reinicia Python, así que también corta el que estuviera esperando.

### La API de Scriptor desde Python

El módulo `scriptor` da acceso a la misma API que los scripts `.js`. Cada llamada es asíncrona, así que lleva `await`:

```python
from scriptor import Device, FS, Net, Photos, Pasteboard, alert, confirm

info = await Device.info()
await FS.writeText('notas/hoy.txt', 'hola')
fotos = await Photos.pick(limit=3)          # los argumentos con nombre van como opciones
await Net.download(url, 'Descargas/v.mp4', onProgress=lambda p: print(p['loaded']))
if await confirm('¿Copiar?'):
    await Pasteboard.copy(info['model'])
```

- Los argumentos con nombre (`limit=3`) se juntan en el objeto de opciones del final.
- Los diccionarios y listas llegan como `dict` y `list`, y los bytes como `bytes`.
- Las funciones que pasas (`onProgress`) reciben valores de Python.
- `scriptor.args` es `Script.input`: los parámetros de `scriptor://run/archivo.py?clave=valor`.

### Archivos: `pull` y `push`

`open()` de Python trabaja en una carpeta propia de Python, en memoria, que se borra al cerrar la app. Para usar archivos de Scriptor (los que ves en Archivos) cópialos de un lado a otro:

- `ruta = await scriptor.pull('datos.csv')` copia un archivo de Documents a `/home/pyodide/datos.csv` y devuelve esa ruta. Con un segundo argumento eliges el destino.
- `await scriptor.push('/home/pyodide/salida.png', 'Imagenes/salida.png')` copia de vuelta a Documents. Sin segundo argumento, va a la raíz con el mismo nombre.

Para leer o escribir texto sin copiar nada, también sirve `await FS.readText(ruta)` / `await FS.writeText(ruta, texto)`.

### Terminal

El botón de terminal, arriba a la izquierda de la lista de scripts, abre una terminal de Python. Sirve para instalar paquetes y probar cosas, aparte de los scripts.

- **`pip install paquete`** instala desde PyPI (con micropip). Solo funcionan paquetes en Python puro o que tengan versión para Pyodide: los que necesitan compilar código C al instalarse no. Lo instalado queda guardado y lo pueden importar todos los scripts `.py`. También hay `pip uninstall`, `pip list`, `pip show` y `pip freeze`.
- **Python interactivo.** Lo que no es un comando se ejecuta como Python. Las variables se mantienen mientras la terminal está abierta, y el valor de la última expresión se muestra solo (`2 + 2` → `4`). Puedes pegar varias líneas a la vez.
- **`python archivo.py a b`** ejecuta un script con argumentos: llegan en `sys.argv`.
- **Archivos:** `ls`, `cd`, `pwd`, `cat`, `cp`, `mv`, `rm`, `mkdir`, `touch` sobre la carpeta de Scriptor. `clear` limpia la pantalla y `help` lista los comandos.
- Si una variable se llama como un comando (`cat = 3`), esa línea es Python. Un `!` delante (`!cat notas.txt`) fuerza el comando.
- iOS no deja ejecutar programas, así que no hay una shell de verdad (bash, git, gcc…): los comandos de arriba están hechos dentro de la app.
- ⏹ detiene lo que se está ejecutando. Reinicia Python, así que se pierden las variables de la sesión.

## Mantener esta guía al día

Python corre en [PythonEngine.swift](../modules/script-engine/ios/PythonEngine.swift) con la página de [python-runtime.js](../modules/script-engine/js/python-runtime.js) y el módulo `scriptor` de [scriptor_py.py](../modules/script-engine/js/scriptor_py.py); la terminal es [src/app/terminal.tsx](../src/app/terminal.tsx). Las miniapps se ejecutan en [src/miniapp](../src/miniapp): `runtime.ts` (compilar y ejecutar), `components.tsx` (componentes), `screen.tsx` (pantalla y API), `device.ts` (hooks de sensores y ubicación, con los módulos de Expo) y `host.ts` (puente con Scriptor). Las APIs se definen en [modules/script-engine/js/prelude.js](../modules/script-engine/js/prelude.js) (APIs de Scriptor) y [scriptable.js](../modules/script-engine/js/scriptable.js) (compatibilidad), sobre las funciones nativas de [modules/script-engine/ios](../modules/script-engine/ios). Al añadir o cambiar una función, actualiza también esta guía y la referencia corta de [src/lib/api-docs.ts](../src/lib/api-docs.ts), que alimenta la pantalla de documentación y el autocompletado del editor.
