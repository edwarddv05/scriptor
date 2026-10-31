# Scriptor's side of Python, loaded into Pyodide before any script: the `scriptor` module,
# input(), the terminal's line runner and pip. Embedded in PythonPage.swift by
# scripts/gen-prelude.mjs: edit this file, not the Swift one.
import asyncio
import builtins
import inspect
import sys
import types

import js
from pyodide.code import eval_code_async
from pyodide.ffi import JsProxy, to_js

HOME = '/home/pyodide'
# Read here, not inside _Api, where Python would mangle the double underscore name.
_bridge = js.__scriptorCall


def _py(value):
    """A JS result as Python: objects become dicts, arrays lists, bytes bytes."""
    if isinstance(value, JsProxy):
        value = value.to_py()
    if isinstance(value, memoryview):
        return value.tobytes()
    if isinstance(value, dict):
        return {key: _py(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_py(item) for item in value]
    return value


def _js(value):
    """A callback's result as JS, so it can travel back (a Net.serve response)."""
    if isinstance(value, (dict, list, tuple, bytes, bytearray)):
        return to_js(value, dict_converter=js.Object.fromEntries)
    return value


def _callable_args(value):
    """Callbacks get Python values (dicts, lists) instead of JS objects, and may be async."""
    if callable(value):
        def call(*args):
            result = value(*[_py(arg) for arg in args])
            if inspect.isawaitable(result):
                async def finish():
                    return _js(await result)
                return asyncio.ensure_future(finish())
            return _js(result)
        return call
    if isinstance(value, dict):
        return {key: _callable_args(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_callable_args(item) for item in value]
    return value


class _Api:
    """A global of Scriptor's API by path (FS.readText, Photos.pick, alert…). Calls are async."""

    def __init__(self, path):
        self._path = path

    def __getattr__(self, name):
        if name.startswith('_'):
            raise AttributeError(name)
        return _Api(f'{self._path}.{name}')

    def __repr__(self):
        return f'<scriptor.{self._path}>'

    async def __call__(self, *args, **kwargs):
        # Keyword arguments become the options object the JS API takes last.
        if kwargs:
            args = (*args, kwargs)
        value = await _bridge(self._path, to_js(_callable_args(list(args)), dict_converter=js.Object.fromEntries, create_pyproxies=True))
        return _py(value)


async def pull(path, dest=None):
    """Copies a file from Scriptor's folder into Python's own, for open(), pandas…; returns the new path."""
    import os

    data = await _Api('FS.readBytes')(path)
    dest = dest or f'{HOME}/{path.rstrip("/").split("/")[-1]}'
    os.makedirs(os.path.dirname(dest) or '.', exist_ok=True)
    with open(dest, 'wb') as file:
        file.write(data)
    return dest


async def push(local, path=None):
    """Copies a file Python wrote back to Scriptor's folder (visible in Files); returns its path there."""
    with open(local, 'rb') as file:
        data = file.read()
    return await _Api('FS.writeBytes')(path or local.rstrip('/').split('/')[-1], data)


def _attribute(name):
    if name.startswith('_'):
        raise AttributeError(name)
    return _Api(name)


scriptor = types.ModuleType('scriptor', "Scriptor's API. Every call is async: text = await FS.readText('a.txt').")
scriptor.__getattr__ = _attribute
scriptor.args = {}
scriptor.pull = pull
scriptor.push = push
sys.modules['scriptor'] = scriptor


def _input(prompt=''):
    # window.prompt shows a native alert; the prompt text goes in it instead of the console.
    value = js.prompt(str(prompt))
    if value is None:
        raise EOFError('Entrada cancelada')
    return str(value)


builtins.input = _input


async def _script(name, code, args):
    scriptor.args = _py(args) or {}
    # `python archivo.py a b` in the terminal passes its words as argv.
    sys.argv = [str(arg) for arg in scriptor.args.get('argv', [name])]
    await eval_code_async(code, globals={'__name__': '__main__', '__file__': name}, filename=name, return_mode='none')


_sessions = {}


async def _line(session, code):
    """One terminal line: names persist in the session and a last expression is printed."""
    namespace = _sessions.setdefault(session, {'__name__': '__main__'})
    result = await eval_code_async(code, globals=namespace, filename='<terminal>')
    if result is not None:
        print(repr(result))


USAGE = """Uso:
  pip install paquete [paquete…]   instala desde PyPI o la distribución de Pyodide
  pip uninstall paquete [paquete…]
  pip list                         paquetes cargados ahora
  pip show paquete
  pip freeze"""


def _save():
    import micropip

    js.__saveLock(micropip.freeze())


async def _pip(argv):
    import micropip

    if not argv or argv[0] in ('help', '-h', '--help'):
        print(USAGE)
        return
    command, names = argv[0], [arg for arg in argv[1:] if not arg.startswith('-')]
    if command == 'install':
        if not names:
            print('Uso: pip install paquete [paquete…]')
            return
        await micropip.install(names)
        _save()
        print('Instalado: ' + ', '.join(names))
    elif command == 'uninstall':
        micropip.uninstall(names)
        _save()
        print('Desinstalado: ' + ', '.join(names))
    elif command in ('list', 'freeze'):
        for name, package in sorted(micropip.list().items()):
            print(f'{name}=={package.version}' if command == 'freeze' else f'{name:<28} {package.version}')
    elif command == 'show':
        packages = micropip.list()
        for name in names:
            package = packages.get(name)
            print(f'Name: {package.name}\nVersion: {package.version}\nSource: {package.source}' if package else f'No está instalado: {name}')
    else:
        print(f'pip: no conozco "{command}".\n{USAGE}')
