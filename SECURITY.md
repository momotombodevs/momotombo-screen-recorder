# Security

## Supported versions

Security fixes are made for the latest published release only.

## Reporting a vulnerability

Please do **not** open a public Issue for security problems. Use GitHub's private vulnerability reporting instead:

1. Open the repository's **Security** tab.
2. Click **Report a vulnerability**.
3. Describe the problem, the affected versions (macOS version and Momotombo version) and the steps to reproduce it.

The report is visible only to the maintainer. Once the problem is confirmed, a fix is released and the report is credited in the release notes, with your name if you wish.

## Scope

Momotombo makes no network requests and sends no telemetry; recordings and projects stay on your computer only. Reports about these are especially important:

- recordings, cursor data or projects unexpectedly leaving the computer;
- privacy areas (blur, pixelate, opaque) being revealed in the exported video;
- the click helper (`native/input-macos`) reading anything beyond mouse buttons and scrolling.
