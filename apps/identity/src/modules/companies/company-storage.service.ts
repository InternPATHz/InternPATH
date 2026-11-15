import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { AppException } from '@internpath/common';

@Injectable()
export class CompanyStorageService {
  private client?: S3Client;
  constructor(private readonly config: ConfigService) {}

  private setting(name: string): string {
    const value = this.config.get<string>(name);
    if (!value) throw new AppException('STORAGE_NOT_CONFIGURED', `${name} is required`, 503);
    return value;
  }

  private s3(): S3Client {
    if (!this.client) this.client = new S3Client({
      endpoint: this.setting('S3_ENDPOINT'),
      region: this.setting('S3_REGION'),
      forcePathStyle: true,
      credentials: { accessKeyId: this.setting('S3_ACCESS_KEY'), secretAccessKey: this.setting('S3_SECRET_KEY') },
    });
    return this.client;
  }

  async upload(kind: 'logo' | 'document', companyId: string, bytes: Buffer, mime: string): Promise<string> {
    const bucket = this.setting(kind === 'logo' ? 'S3_BUCKET_PUBLIC' : 'S3_BUCKET_PRIVATE');
    const extension = mime === 'application/pdf' ? 'pdf' : mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
    const key = `companies/${companyId}/${kind}/${randomUUID()}.${extension}`;
    await this.s3().send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, ContentType: mime }));
    return key;
  }

  publicUrl(key: string): string {
    const base = this.config.get<string>('S3_PUBLIC_BASE_URL') ?? `${this.setting('S3_ENDPOINT').replace(/\/$/, '')}/${this.setting('S3_BUCKET_PUBLIC')}`;
    return `${base.replace(/\/$/, '')}/${key.split('/').map(encodeURIComponent).join('/')}`;
  }

  async signedUrl(key: string): Promise<string> {
    return getSignedUrl(this.s3(), new GetObjectCommand({ Bucket: this.setting('S3_BUCKET_PRIVATE'), Key: key }), { expiresIn: 600 });
  }
}
