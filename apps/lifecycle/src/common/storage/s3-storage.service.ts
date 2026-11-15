import { randomUUID } from 'node:crypto';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class S3StorageService {
  private readonly client: S3Client;
  private readonly privateBucket: string;

  constructor(private readonly config: ConfigService) {
    const endpoint = this.config.get<string>('S3_ENDPOINT');
    const region = this.config.get<string>('S3_REGION', 'auto');
    const accessKeyId = this.config.get<string>('S3_ACCESS_KEY');
    const secretAccessKey = this.config.get<string>('S3_SECRET_KEY');

    if (!accessKeyId || !secretAccessKey) {
      throw new Error('S3 credentials are not configured (S3_ACCESS_KEY and S3_SECRET_KEY are required)');
    }

    const forcePathStyle = this.config.get<string>('S3_FORCE_PATH_STYLE', 'true') === 'true';

    this.privateBucket = this.config.get<string>('S3_BUCKET_PRIVATE', 'internpath-private');

    this.client = new S3Client({
      endpoint,
      region,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
      forcePathStyle,
    });
  }

  /**
   * สร้าง Object Key เป็น UUID สุ่มล้วน ห้ามมีชื่อไฟล์เดิมหรือ PII (README §5.9)
   */
  generateKey(prefix?: string, extension?: string): string {
    const uuid = randomUUID();
    const ext = extension ? (extension.startsWith('.') ? extension : `.${extension}`) : '';
    return prefix ? `${prefix}/${uuid}${ext}` : `${uuid}${ext}`;
  }

  /**
   * อัปโหลดไฟล์ขึ้น Private Bucket
   */
  async upload(key: string, body: Buffer | Uint8Array, contentType: string): Promise<{ key: string; sizeBytes: number }> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.privateBucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
    return { key, sizeBytes: body.length };
  }

  /**
   * สร้าง Signed URL สำหรับดาวน์โหลด อายุประมาณ 10 นาที (ค่าเริ่มต้น 600 วินาที)
   */
  async getSignedDownloadUrl(key: string, expiresInSeconds = 600): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.privateBucket,
      Key: key,
    });
    return getSignedUrl(this.client, command, { expiresIn: expiresInSeconds });
  }

  /**
   * ลบไฟล์ออกจาก Private Bucket (เช่น เมื่อได้รับ UserDeletionRequested)
   */
  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.privateBucket,
        Key: key,
      }),
    );
  }
}
