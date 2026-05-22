// src/providers/gdrive.js
import { config } from '../../config/index.js'
import { logger } from '../utils/logger.js'

let drive = null

export async function getDriveClient() {
  if (drive) return drive

  const credsStr = process.env.GDRIVE_CREDENTIALS_JSON
  if (!credsStr) return null

  try {
    const creds = JSON.parse(credsStr)
    const { google } = await import('googleapis')
    const auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: creds.client_email,
        private_key: creds.private_key,
      },
      scopes: ['https://www.googleapis.com/auth/drive.file'],
    })
    drive = google.drive({ version: 'v3', auth })
    return drive
  } catch (err) {
    logger.error(`[gdrive] Failed to initialize Google Drive client: ${err.message}`)
    return null
  }
}

/**
 * .md 파일을 구글 드라이브에 업로드
 * @param {string} filename 
 * @param {string} content 
 */
export async function uploadMarkdownToDrive(filename, content) {
  const folderId = process.env.GDRIVE_FOLDER_ID
  const client = await getDriveClient()

  if (!client || !folderId) {
    logger.info('[gdrive] Google Drive not configured (GDRIVE_CREDENTIALS_JSON or GDRIVE_FOLDER_ID missing). Skipping upload.')
    return null
  }

  try {
    const fileMetadata = {
      name: filename,
      parents: [folderId]
    }
    const media = {
      mimeType: 'text/markdown',
      body: content
    }

    const res = await client.files.create({
      requestBody: fileMetadata,
      media: media,
      fields: 'id, webViewLink'
    })

    logger.info(`[gdrive] Uploaded ${filename} successfully. ID: ${res.data.id}`)
    return res.data.webViewLink
  } catch (err) {
    logger.error(`[gdrive] Failed to upload ${filename}: ${err.message}`)
    return null
  }
}
