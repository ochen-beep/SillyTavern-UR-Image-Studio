// @ts-check

/**
 * Whether a JPEG carries an EXIF orientation other than upright. A stored
 * reference that passes through untouched keeps the tag, and a provider that
 * ignores EXIF would render it rotated. Undecodable bytes count as rotated:
 * the canvas path is the safe one for them.
 *
 * @param {ArrayBuffer} bytes
 * @returns {boolean}
 */
export function jpegExifRotated(bytes) {
    try {
        const view = new DataView(bytes);
        const u16 = (at, little = false) => view.getUint16(at, little);
        if (u16(0) !== 0xffd8) return true;
        for (let offset = 2; view.getUint8(offset) === 0xff;) {
            // Fill bytes may precede a marker.
            if (view.getUint8(offset + 1) === 0xff) {
                offset += 1;
                continue;
            }
            const marker = view.getUint8(offset + 1);
            // Scan data and EOI: no EXIF can follow.
            if (marker === 0xda || marker === 0xd9) return false;
            // TEM and RSTn carry no payload length.
            if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
                offset += 2;
                continue;
            }
            const length = view.getUint16(offset + 2);
            // A segment too short to hold its own length is broken bytes.
            if (length < 2) return true;
            // APP1 whose payload starts with "Exif\0\0".
            if (marker === 0xe1 && view.getUint32(offset + 4) === 0x45786966) {
                const tiff = offset + 10;
                const little = u16(tiff) === 0x4949;
                const entry = tiff + view.getUint32(tiff + 4, little);
                for (let n = 0; n < u16(entry, little); n += 1) {
                    const tag = entry + 2 + n * 12;
                    // Orientation.
                    if (u16(tag, little) === 0x0112) return u16(tag + 8, little) !== 1;
                }
                return false;
            }
            offset += 2 + length;
        }
        return false;
    } catch {
        return true;
    }
}
