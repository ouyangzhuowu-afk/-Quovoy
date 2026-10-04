import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Quovoy · 外贸工作台',
  description: '从询价原文到获批报价，让制造企业的外贸协作有据可查。',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
