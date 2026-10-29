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

- **Cabecera.** La línea `// icon-color: …; icon-glyph: …;` fija el color y el icono del script en la rejilla. Usa el mismo formato que Scriptable, así que se conserva si llevas el script allí. Puedes cambiarlos manteniendo pulsado el script.
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

## Mantener esta guía al día

Las APIs se definen en [modules/script-engine/js/prelude.js](../modules/script-engine/js/prelude.js) (APIs de Scriptor) y [scriptable.js](../modules/script-engine/js/scriptable.js) (compatibilidad), sobre las funciones nativas de [modules/script-engine/ios](../modules/script-engine/ios). Al añadir o cambiar una función, actualiza también esta guía y la referencia corta de [src/lib/api-docs.ts](../src/lib/api-docs.ts), que alimenta la pantalla de documentación y el autocompletado del editor.
