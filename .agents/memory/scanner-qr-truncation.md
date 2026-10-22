---
name: OpenCV truncates dense vCard QR codes
description: Why business-card vCard QR scans drop email/phone/address, and the fix.
---

# OpenCV QRCodeDetector truncates dense vCard QR payloads

OpenCV's `cv2.QRCodeDetector` decodes the *early* fields of a dense vCard QR
(N/FN/ORG/TITLE) but silently **drops the later ones** (EMAIL/TEL/ADR/URL).
The result: name + company come through, everything else is blank — even
though the QR genuinely contains all the fields.

**Why:** this surfaced as "scanner returns blank email/phone/website/address"
on badges whose QR is a full vCard. The browser's jsQR / BarcodeDetector (which
already runs for camera auto-capture) decodes the *complete* payload reliably.

**How to apply:** the browser-decoded QR text is sent to the backend as a
`qr_payload` form field on both the camera and file-upload paths. The server
keeps the **richer (longer)** of the client payload vs its own OpenCV decode
(OpenCV is also retried over grayscale/upscaled variants). Trust the longer
decode — it carries the fields the truncated one lost. Cap the inbound
`qr_payload` length (a real QR maxes ~3KB) since it is untrusted client text.
