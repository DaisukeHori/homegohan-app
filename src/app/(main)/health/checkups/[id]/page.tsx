import { notFound } from "next/navigation";
import { z } from "zod";

export const dynamic = 'force-dynamic';
import CheckupDetailClient from "./CheckupDetailClient";

const UUID = z.string().uuid();

export default async function HealthCheckupDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const parsed = UUID.safeParse(id);
  if (!parsed.success) {
    notFound();
  }

  return <CheckupDetailClient id={parsed.data} />;
}
