tag audio-engine-layer-stable
commit 1579204
qué cambió
qué NO se toca
tests pasados
riesgos abiertos

3. Siguiente mejora técnica
Después de validar, yo iría a:

Android background hardening

No a features.
El objetivo: que Android no nos mate, no duplique servicios, no deje wake locks raros y no bloquee el micrófono.