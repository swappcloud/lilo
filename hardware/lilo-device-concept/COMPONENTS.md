# Selected components

The enclosure uses the following reference parts. Manufacturer drawings and CAD define the geometry; check purchased revisions and print fit before assembly.

| Part | Reference and dimensions | Connection |
| --- | --- | --- |
| Round AMOLED | [Waveshare ESP32-S3-Touch-AMOLED-1.75](https://docs.waveshare.com/ESP32-S3-Touch-AMOLED-1.75): 466 × 466 pixels, 48.96 mm outer glass, 43.76 mm active circle, approximately 46 mm PCB. | QSPI display connected to its onboard ESP32-S3; side-facing USB-C provides programming/data and power. This is not an HDMI monitor. |
| Linux computer | [Raspberry Pi 4 Model B](https://www.raspberrypi.com/products/raspberry-pi-4-model-b/), 85 × 56 mm board, 58 × 49 mm mounting pattern. Used as a mechanical reference; minimum RAM has not been established. | Native USB-C power, networking and USB peripherals. The same daemon can run on other compatible Linux computers with different mounting geometry. |
| USB audio | [Seeed ReSpeaker Lite](https://wiki.seeedstudio.com/reSpeaker_usb_v3/), nominal 35 × 86 mm. | USB Audio Class 2 firmware supports capture/playback; the board has a physical firmware-controlled mute switch and amplified speaker output. |
| Speaker | [Seeed Mono Enclosed Speaker 4R 5W](https://www.seeedstudio.com/Mono-Enclosed-Speaker-4R-5W-p-5931.html), SKU 114993346, 50 × 45 × 22 mm. | Matched speaker connection to ReSpeaker; confirm connector and polarity on the purchased revision. |
| Power button | [Adafruit #481](https://www.adafruit.com/product/481), 16 mm panel barrel, 18 mm bezel, normally-open momentary switch. | GPIO3 / ground for an operating-system-configured shutdown/wake control. It does not disconnect the supply. |
| Supply | Board-manufacturer-rated USB-C supply; Pi 4 reference normally requires 5 V / 3 A. | Directly into the exposed native Pi socket. The Pi 4 peripheral USB current budget is 1.2 A total. Measure the combined AMOLED and audio load; use rated powered USB distribution if required. |

## Geometry sources

- [Waveshare official STEP/DWG/PDF archive](https://files.waveshare.com/wiki/ESP32-S3-Touch-AMOLED-1.75/ESP32-S3-Touch-AMOLED-1.75-3D.zip). The mechanical sheet gives a 10.40 mm stack; the supplied STEP spans 12.70 mm including the projecting header. This design reserves the larger CAD envelope. USB-C is radial, not rear-facing.
- ReSpeaker Lite revision 1.1 STEP from the [manufacturer resources](https://wiki.seeedstudio.com/reSpeaker_usb_v3/). Its imported envelope is approximately 83.60 × 34.01 × 10.93 mm; the product's nominal 35 × 86 mm description is a separate specification. The outermost tactile switch near the USB/speaker end is Mute; the adjacent switch is Usr.
- [Pi 4 official mechanical DXF](https://pip-assets.raspberrypi.com/categories/545-raspberry-pi-4-model-b/documents/RP-008342-DS-1-raspberry-pi-4-mechanical-drawing.dxf). Its USB-C power centerline is 11.2 mm from the PCB's left edge. The viewer reconstructs the board from these dimensions; it does not redistribute third-party board CAD.
- [Speaker manufacturer datasheet](https://mm.digikey.com/Volume0/opasdata/d220001/medias/docus/8932/114993346.pdf). The viewer's speaker is a dimensioned reconstruction.

The display and ReSpeaker meshes are imported manufacturer geometry. Component-layer separation and source SHA-256 values are recorded in components/sources.json. Cable curves represent routing estimates; they do not replace cable measurements.

## Display and microphone integration

The ESP32 can render the LILO character locally using custom firmware while Linux runs the daemon and provider transport. That keeps display rendering off the Linux browser/audio host. The desktop character remains the visual source; the preview uses a still generated from the shared LiloModel.

The AMOLED board includes two microphones, an ES7210 input ADC and ES8311 output codec. Its official examples access audio through I2S and describe USB-C programming/logging. No ready-to-use USB Audio firmware was identified in those examples. Reusing its microphones requires firmware that exposes audio to Linux and validation of full-duplex capture, playback and echo handling. The current reference assembly therefore uses ReSpeaker USB audio.

The display firmware and Linux-to-display link are separate implementation work. The mechanical preview establishes geometry and the intended appearance; it does not establish a running LILO firmware build. No battery is needed in this mains-powered reference assembly.
