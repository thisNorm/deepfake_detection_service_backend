// files.service.ts
import { Injectable } from '@nestjs/common';
import axios from 'axios';
import FormData from 'form-data';

@Injectable()
export class FilesService {
  // 배포된 ML 서버(FastAPI/Uvicorn)로 바로 업로드하여 결과 받기
  private readonly ML_URL =
    (process.env.ML_URL || 'http://127.0.0.1:8000').replace(/\/$/, '');
  private readonly ML_PREDICT_PATH = process.env.ML_PREDICT_PATH || '/predict';
  private readonly ML_TIMEOUT_MS = Number(process.env.ML_TIMEOUT_MS || 60000);

  async processFile(file: Express.Multer.File) {
    // 디스크 저장 없이 바로 멀티파트로 전달 (최소 변경)
    const form = new FormData();
    form.append('file', file.buffer, {
      filename: file.originalname || 'upload.bin',
      contentType: file.mimetype || 'application/octet-stream',
    });

    const url = `${this.ML_URL}${this.ML_PREDICT_PATH}`;

    const resp = await axios.post(url, form, {
      headers: { ...form.getHeaders() },
      timeout: this.ML_TIMEOUT_MS,
      proxy: false,
      validateStatus: () => true,
    });

    if (resp.status < 200 || resp.status >= 300) {
      throw new Error(
        `ML server error ${resp.status}: ${
          typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data)
        }`,
      );
    }

    // FastAPI가 반환한 JSON을 그대로 전달
    return { result: resp.data };
  }
}