// src/utils/mp3.js
// Utility for parsing and cleaning MP3 buffers to enable seamless binary concatenation
// without introducing corrupted frames, ID3 tags, or incorrect duration Xing headers.

import { logger } from './logger.js'

/**
 * Calculates the size of an MP3 frame in bytes based on its header.
 * Only supports MPEG Audio Layer III (MP3).
 * 
 * @param {Buffer} headerBuf - Buffer starting at the MP3 frame header (at least 4 bytes)
 * @returns {number} Frame size in bytes, or 0 if invalid/unsupported
 */
function getMp3FrameSize(headerBuf) {
  if (headerBuf.length < 4) return 0;
  if (headerBuf[0] !== 0xFF || (headerBuf[1] & 0xE0) !== 0xE0) return 0;

  const versionIndex = (headerBuf[1] & 0x18) >> 3;
  const layerIndex = (headerBuf[1] & 0x06) >> 1;
  const bitrateIndex = (headerBuf[2] & 0xF0) >> 4;
  const sampleRateIndex = (headerBuf[2] & 0x0C) >> 2;
  const padding = (headerBuf[2] & 0x02) >> 1;

  // We only support Layer III (MP3)
  if (layerIndex !== 1) return 0;

  let version;
  if (versionIndex === 3) version = 1;      // MPEG-1
  else if (versionIndex === 2) version = 2; // MPEG-2
  else if (versionIndex === 0) version = 2.5; // MPEG-2.5
  else return 0;                             // Reserved

  const bitrates = {
    1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0],
    2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
    2.5: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0]
  };

  const sampleRates = {
    1: [44100, 48000, 32000, 0],
    2: [22050, 24000, 16000, 0],
    2.5: [11025, 12000, 8000, 0]
  };

  const bitrate = bitrates[version]?.[bitrateIndex] * 1000;
  const sampleRate = sampleRates[version]?.[sampleRateIndex];

  if (!bitrate || !sampleRate) return 0;

  if (version === 1) {
    return Math.floor(144 * bitrate / sampleRate) + padding;
  } else {
    return Math.floor(72 * bitrate / sampleRate) + padding;
  }
}

/**
 * Checks if an MP3 frame is a Xing or Info header frame.
 * Xing/Info headers contain metadata like duration and play count, which
 * confuse decoders when concatenated inside a longer audio file.
 * 
 * @param {Buffer} frameBuf - The complete MP3 frame buffer
 * @returns {boolean} True if the frame is a Xing or Info header
 */
function isXingFrame(frameBuf) {
  if (frameBuf.length < 40) return false;
  
  // Xing/Info strings can appear at offsets 13, 21, or 36 depending on MPEG version and mono/stereo
  const offsets = [13, 21, 36];
  for (const offset of offsets) {
    if (frameBuf.length >= offset + 4) {
      const str = frameBuf.toString('ascii', offset, offset + 4);
      if (str === 'Xing' || str === 'Info') {
        return true;
      }
    }
  }
  return false;
}

/**
 * Strips ID3v2 tags, Xing/Info header frames, and ID3v1 tags from an MP3 buffer.
 * Returns a buffer containing only raw MP3 audio frames, suitable for seamless concatenation.
 * 
 * @param {Buffer} buf - Original MP3 buffer
 * @returns {Buffer} Cleaned raw MP3 audio frames buffer
 */
export function cleanMp3Buffer(buf) {
  if (!buf || buf.length === 0) return buf;

  let offset = 0;

  // 1. Skip ID3v2 tag at the beginning of the file
  if (buf.length > 10 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) { // "ID3"
    const flags = buf[5];
    const size = (buf[6] << 21) | (buf[7] << 14) | (buf[8] << 7) | buf[9];
    const hasFooter = (flags & 0x10) !== 0;
    const tagSize = 10 + size + (hasFooter ? 10 : 0);
    logger.info(`[mp3] Skipped ID3v2 tag: size=${tagSize} bytes`);
    offset = tagSize;
  }

  // 2. Scan and skip Xing/Info headers in the first MPEG audio frame
  while (offset < buf.length) {
    // Look for the next MP3 sync word (0xFF and high 3 bits set of next byte)
    if (buf[offset] === 0xFF && (buf[offset + 1] & 0xE0) === 0xE0) {
      const remainingBuf = buf.subarray(offset);
      const frameSize = getMp3FrameSize(remainingBuf);
      if (frameSize > 0) {
        const frameBuf = remainingBuf.subarray(0, frameSize);
        if (isXingFrame(frameBuf)) {
          logger.info(`[mp3] Skipped Xing/Info frame of size=${frameSize} bytes at offset=${offset}`);
          offset += frameSize;
          continue; // Continue scanning in case of multiple headers (rare but safe)
        }
      }
      break; // Found first true audio frame! Stop skipping.
    }
    offset++;
  }

  let cleaned = buf.subarray(offset);

  // 3. Strip ID3v1 tag from the end of the file (fixed 128 bytes starting with "TAG")
  if (cleaned.length >= 128) {
    const endOffset = cleaned.length - 128;
    if (cleaned[endOffset] === 0x54 && cleaned[endOffset + 1] === 0x41 && cleaned[endOffset + 2] === 0x47) { // "TAG"
      logger.info('[mp3] Stripped ID3v1 tag from end of file');
      cleaned = cleaned.subarray(0, endOffset);
    }
  }

  return cleaned;
}

/**
 * Parses the sample rate and channel layout (mono/stereo) of the first MP3 frame.
 * 
 * @param {Buffer} buf - MP3 buffer
 * @returns {{sampleRate: number, isMono: boolean} | null} Parsed format, or null if invalid
 */
export function getAudioFormat(buf) {
  if (!buf || buf.length === 0) return null;

  let offset = 0;
  // Skip ID3v2 tag
  if (buf.length > 10 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
    const flags = buf[5];
    const size = (buf[6] << 21) | (buf[7] << 14) | (buf[8] << 7) | buf[9];
    const hasFooter = (flags & 0x10) !== 0;
    offset = 10 + size + (hasFooter ? 10 : 0);
  }

  // Find first frame sync word
  while (offset < buf.length - 4) {
    if (buf[offset] === 0xFF && (buf[offset + 1] & 0xE0) === 0xE0) {
      break;
    }
    offset++;
  }

  if (offset >= buf.length - 4) return null;

  const h = buf.subarray(offset, offset + 4);
  const versionIndex = (h[1] & 0x18) >> 3;
  const sampleRateIndex = (h[2] & 0x0C) >> 2;
  const channelModeIndex = (h[3] & 0xC0) >> 6;

  let version;
  if (versionIndex === 3) version = 'MPEG-1';
  else if (versionIndex === 2) version = 'MPEG-2';
  else if (versionIndex === 0) version = 'MPEG-2.5';
  else return null;

  const sampleRates = {
    'MPEG-1': [44100, 48000, 32000, 0],
    'MPEG-2': [22050, 24000, 16000, 0],
    'MPEG-2.5': [11025, 12000, 8000, 0]
  };

  const sampleRate = sampleRates[version]?.[sampleRateIndex];
  if (!sampleRate) return null;

  const isMono = channelModeIndex === 3;

  return { sampleRate, isMono };
}
