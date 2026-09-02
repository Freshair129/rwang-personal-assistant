# Local perception assets

RWANG serves these files from the same origin so gesture and face inference can run without a runtime CDN dependency.

- `tasks-vision.mjs` and `wasm/*`: `@mediapipe/tasks-vision` 1.0.1 (Apache-2.0), copied from the installed npm package.
- `gesture_recognizer.task`: MediaPipe Gesture Recognizer, downloaded from `https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task`.
  - SHA-256: `97952348CF6A6A4915C2EA1496B4B37EBABC50CBBF80571435643C455F2B0482`
- `face_landmarker.task`: MediaPipe Face Landmarker, downloaded from `https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task`.
  - SHA-256: `64184E229B263107BC2B804C6625DB1341FF2BB731874B0BCC2FE6544E0BC9FF`

See the MediaPipe package privacy notice and model documentation before redistributing or replacing these files. Face and voice profiles produced by RWANG are experimental device-local templates, not authentication factors.
