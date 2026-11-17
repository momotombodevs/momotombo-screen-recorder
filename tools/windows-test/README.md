# Windows test

Tries Momotombo's Windows package on a real Windows 10/11 x64 computer. It runs the app's own tests: the smoke test (WebGL2 preview, editing, export, licenses) and the codec probe (recording formats).

It tries four configurations:

| Configuration   | What is tried                                                                                               |
| --------------- | ----------------------------------------------------------------------------------------------------------- |
| `bundled`       | The package as it is today, with `d3dcompiler_47.dll` next to the app.                                      |
| `no-dll-d3d11`  | DLL moved aside; Direct3D 11 backend. It has to find the DLL somewhere else, for example Windows' own copy. |
| `no-dll-vulkan` | DLL moved aside; Vulkan backend. No HLSL compiler needed.                                                   |
| `no-dll-gl`     | DLL moved aside; OpenGL backend. No HLSL compiler needed.                                                   |

The DLL is put back when the test ends. The script installs nothing and sends nothing to the network.

```powershell
powershell -ExecutionPolicy Bypass -File run-windows-tests.ps1 -App "C:\Users\<you>\Downloads\Momotombo"
```

If you downloaded the zip from the internet, Windows may block the files. First run this in the folder:

```powershell
Get-ChildItem -Recurse | Unblock-File
```

Because the app is unsigned, SmartScreen may say "Windows protected your PC". In that case choose **More info › Run anyway**. Momotombo windows open and close several times during the test; do not use the computer until it finishes.

Results are written to `momotombo-windows-test\summary.json`. The `renderer` column shows which graphics backend actually ran (for example `Direct3D11`, `Vulkan`, `OpenGL`).

This result decides whether the Windows version can be distributed without the Microsoft DLL. If possible, run it on both a Windows 10 and a Windows 11 computer.
