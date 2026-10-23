import type { Metadata } from "next";
import { auth } from "@clerk/nextjs/server";

import DashboardClient from "@/components/dashboard/DashboardClient";
import type { BusinessType } from "@/features/analyses/analysis-service";

export const metadata: Metadata = {
  title: "Analytics",
};

type AnalyticsPageProps = {
  searchParams: Promise<{
    mode?: string;
    ids?: string;
    lat?: string;
    lng?: string;
    radius?: string;
    category?: string;
    location_id?: string;
  }>;
};

const businessTypes: BusinessType[] = [
  "food stall",
  "sari-sari store",
  "general retail",
];

export default async function AnalyticsPage({
  searchParams,
}: AnalyticsPageProps) {
  await auth.protect();

  const params = await searchParams;

  const analyticsMode = params.mode === "saved" ? "saved" : "area";

  const savedIds = params.ids?.split(",").filter(Boolean) ?? [];

  const lat = Number(params.lat);
  const lng = Number(params.lng);
  const requestedRadius = Number(params.radius);

  const initialArea = {
    point: {
      lat: params.lat !== undefined && Number.isFinite(lat) ? lat : 14.5995,
      lng: params.lng !== undefined && Number.isFinite(lng) ? lng : 120.9842,
    },
    radius: [250, 500, 1000, 2000].includes(requestedRadius)
      ? requestedRadius
      : 500,
    category: businessTypes.includes(params.category as BusinessType)
      ? (params.category as BusinessType)
      : ("food stall" as BusinessType),
  };

  return (
    <DashboardClient
      view="analytics"
      analyticsMode={analyticsMode}
      savedIds={savedIds}
      initialArea={initialArea}
      initialLocationId={params.location_id}
    />
  );
}
