"use client";

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  getSuitabilityLevel,
  SUITABILITY_STYLES,
} from "@/features/analyses/suitability";
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueries,
  useQueryClient,
} from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { useRouter } from "next/navigation";

import { formatModelFlag } from "@/features/analyses/candidate-insights";

import { useClerkApi } from "@/lib/api/client";
import {
  createAnalysis,
  getLocations,
  type AnalysisRequest,
  type BusinessType,
  type CandidateLocation,
  getLocationScores,
} from "@/features/analyses/analysis-service";

import AnalyticsOverview from "@/components/analytics/AnalyticsOverview";
import SavedLocationsWorkspace from "@/components/saved-locations/SavedLocationsWorkspace";
import SavedLocationsAnalytics from "@/components/saved-locations/SavedLocationsAnalytics";
import CandidateLocationCard from "./CandidateLocationCard";
import {
  SAVED_LOCATIONS_KEY,
  savedKey,
  getSavedLocations,
  saveLocation,
  removeSavedLocation,
} from "@/features/saved-locations/saved-location-service";

import Link from "next/link";

import { useSiteSuriUser } from "@/features/users/use-user";

import MapWorkspace, { type GeoPoint } from "./MapWorkspace";
import DashboardSidebar from "./DashboardSidebar";
import CustomSelect from "@/components/ui/CustomSelect";
import AccountMenu from "./AccountMenu";

import {
  Menu,
  X,
  MapPinned,
  SlidersHorizontal,
  Search,
  ShieldCheck,
  ArrowRight,
  BookmarkPlus,
  BookmarkCheck,
} from "lucide-react";

type PlaceResult = { id: string; name: string; lat: number; lng: number };
const initialPoint: GeoPoint = { lat: 14.5995, lng: 120.9842 }; // Manila center, not a scored candidate.
const MemoizedMapWorkspace = memo(MapWorkspace);
const BUSINESS_CATEGORY_OPTIONS = [
  { value: "food stall", label: "Food stall" },
  { value: "sari-sari store", label: "Sari-sari store" },
  { value: "general retail", label: "General retail" },
] as const;

const RADIUS_OPTIONS = [250, 500, 1000, 2000].map((meters) => ({
  value: String(meters),
  label: meters >= 1000 ? `${meters / 1000} km` : `${meters} meters`,
}));

function isBusinessType(value: string): value is BusinessType {
  return BUSINESS_CATEGORY_OPTIONS.some((option) => option.value === value);
}

function getApiErrorMessage(error: unknown, fallback: string): string {
  if (isAxiosError(error)) {
    if (error.response?.status === 401)
      return "Your session expired. Please sign in again.";
    if (error.response?.status === 404)
      return "The selected location or its score was not found.";
    if (error.response?.status === 422)
      return "The server rejected the analysis criteria.";
    if (error.response?.status === 503)
      return "The analysis service is temporarily unavailable.";
  }
  return error instanceof Error ? error.message : fallback;
}

function distanceMeters(from: GeoPoint, to: GeoPoint): number {
  const earthRadius = 6371000;
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

  const dLat = toRadians(to.lat - from.lat);
  const dLng = toRadians(to.lng - from.lng);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(from.lat)) *
      Math.cos(toRadians(to.lat)) *
      Math.sin(dLng / 2) ** 2;

  return 2 * earthRadius * Math.asin(Math.sqrt(Math.min(1, a)));
}

type DashboardClientProps = {
  view?: "explorer" | "analytics" | "saved";
  analyticsMode?: "area" | "saved";
  savedIds?: string[];
  initialLocationId?: string;
  initialArea?: {
    point: GeoPoint;
    radius: number;
    category: BusinessType;
  };
};

function DashboardContent({
  view = "explorer",
  analyticsMode = "area",
  savedIds,
  initialArea,
  initialLocationId,
}: DashboardClientProps) {
  const {
    user: appUser,
    isLoading: accountLoading,
    isError: accountError,
    retrySync,
  } = useSiteSuriUser();

  const api = useClerkApi();
  const queryClient = useQueryClient();
  const router = useRouter();

  const [sidebarExpanded, setSidebarExpanded] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

  const [point, setPoint] = useState<GeoPoint>(
    initialArea?.point ?? initialPoint,
  );

  const [radius, setRadius] = useState(initialArea?.radius ?? 500);

  const [category, setCategory] = useState<BusinessType>(
    initialArea?.category ?? "food stall",
  );
  const [selectedLocation, setSelectedLocation] =
    useState<CandidateLocation | null>(null);
  const [expandedLocationId, setExpandedLocationId] = useState<string | null>(
    null,
  );
  const [searchTerm, setSearchTerm] = useState("");
  const [results, setResults] = useState<PlaceResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchMessage, setSearchMessage] = useState("");
  const hasBackend = Boolean(process.env.NEXT_PUBLIC_API_URL);

  const locationsQuery = useQuery({
    queryKey: ["sitesuri", "candidate-locations"],
    queryFn: () => getLocations(api),
    enabled:
      hasBackend &&
      (view === "explorer" ||
        (view === "analytics" && analyticsMode === "area")),
    staleTime: 5 * 60 * 1000,
  });

  const initializedLocationRef = useRef<string | null>(null);

  useEffect(() => {
    if (view !== "analytics" || analyticsMode !== "area" || !initialArea) {
      return;
    }

    setRadius(initialArea.radius);
  }, [view, analyticsMode, initialArea?.radius]);

  useEffect(() => {
    if (
      view !== "analytics" ||
      analyticsMode !== "area" ||
      !initialLocationId ||
      initializedLocationRef.current === initialLocationId
    ) {
      return;
    }

    const matchingLocation = locationsQuery.data?.find(
      (location) => location.location_id === initialLocationId,
    );

    if (!matchingLocation) return;

    setSelectedLocation(matchingLocation);
    initializedLocationRef.current = initialLocationId;
  }, [view, analyticsMode, initialLocationId, locationsQuery.data]);

  const nearbyCandidates = useMemo(() => {
    const locations = locationsQuery.data ?? [];

    return locations
      .map((location) => ({
        location,
        distance: distanceMeters(point, {
          lat: location.latitude,
          lng: location.longitude,
        }),
      }))
      .filter(({ distance }) => distance <= radius)
      .sort((a, b) => a.distance - b.distance);
  }, [locationsQuery.data, point, radius]);

  const nearbyScoreQueries = useQueries({
    queries: nearbyCandidates.map(({ location }) => ({
      queryKey: ["sitesuri", "location-scores", location.location_id, category],

      queryFn: () => getLocationScores(api, location.location_id, category),

      enabled:
        hasBackend &&
        (view === "explorer" ||
          (view === "analytics" && analyticsMode === "area")),
      staleTime: 5 * 60 * 1000,
      retry: false,
    })),
  });
  const rankedCandidates = nearbyCandidates
    .map((candidate, index) => {
      const query = nearbyScoreQueries[index];

      const score = query.data?.find((item) => item.business_type === category);

      return {
        ...candidate,
        score: score?.location_score ?? null,

        // Preserve the complete scoring response.
        scoreDetails: score ?? null,

        isLoading: query.isPending,
        isError: query.isError,
      };
    })
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1));

  const scoresByLocationId = useMemo(
    () =>
      Object.fromEntries(
        rankedCandidates.map(({ location, score }) => [
          location.location_id,
          score,
        ]),
      ),
    [rankedCandidates],
  );

  // Shared query for bookmark states in the explorer.
  const savedLocationsQuery = useQuery({
    queryKey: SAVED_LOCATIONS_KEY,
    queryFn: () => getSavedLocations(api),
    enabled: hasBackend && Boolean(appUser) && view === "explorer",
    staleTime: 60_000,
  });

  const savedByCandidate = new Map(
    (savedLocationsQuery.data ?? []).map((row) => [
      savedKey(row.location_id, row.business_type),
      row,
    ]),
  );

  const bookmarkMutation = useMutation({
    mutationFn: async ({
      locationId,
      savedId,
    }: {
      locationId: string;
      savedId?: string;
    }): Promise<void> => {
      if (savedId) {
        // Remove an existing bookmark.
        await removeSavedLocation(api, savedId);
      } else {
        // Save a new candidate location.
        await saveLocation(api, {
          location_id: locationId,
          business_type: category,
        });
      }
    },

    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: SAVED_LOCATIONS_KEY,
      });
    },
  });

  const analysisMutation = useMutation({
    mutationFn: (request: AnalysisRequest) => createAnalysis(api, request),
  });

  // An older analysis must never be displayed for newly selected criteria.
  const variables = analysisMutation.variables;
  const activeAnalysis =
    analysisMutation.isSuccess &&
    selectedLocation &&
    variables?.location_id === selectedLocation.location_id &&
    variables?.business_type === category &&
    variables?.display_radius_meters === radius
      ? analysisMutation.data
      : null;

  const score = activeAnalysis?.score;
  const analysisResultRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!activeAnalysis?.score) return;

    analysisResultRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  }, [activeAnalysis]);
  const isCurrentRequest =
    Boolean(selectedLocation) &&
    variables?.location_id === selectedLocation?.location_id &&
    variables?.business_type === category &&
    variables?.display_radius_meters === radius;
  const currentAnalysisError =
    analysisMutation.isError && isCurrentRequest
      ? analysisMutation.error
      : null;

  const handlePickPoint = useCallback((nextPoint: GeoPoint) => {
    setPoint(nextPoint);
    setSelectedLocation(null);
    setExpandedLocationId(null);
  }, []);

  const handleSelectLocation = useCallback(
    (location: CandidateLocation | null) => {
      setSelectedLocation(location);
    },
    [],
  );

  function handleAnalyzeCandidate(location: CandidateLocation) {
    const params = new URLSearchParams({
      lat: String(location.latitude),
      lng: String(location.longitude),
      radius: String(radius),
      category,
      location_id: location.location_id,
    });

    router.push(`/dashboard/analytics?${params.toString()}`);
  }

  function handleAnalyze() {
    if (!selectedLocation || analysisMutation.isPending || !appUser) return;

    analysisMutation.mutate({
      location_id: selectedLocation.location_id,
      business_type: category,
      display_radius_meters: radius,
    });
  }

  async function searchLocation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setResults([]);
    setSearchMessage("");
    const query = searchTerm.trim();
    if (query.length < 3) {
      setSearchMessage("Enter at least three characters.");
      return;
    }
    const key = process.env.NEXT_PUBLIC_MAPTILER_KEY;
    if (!key) {
      setSearchMessage(
        "Address search is not configured yet. Click anywhere on the map to select a point.",
      );
      return;
    }
    setSearching(true);
    try {
      const url = `https://api.maptiler.com/geocoding/${encodeURIComponent(query)}.json?key=${encodeURIComponent(key)}&country=ph&limit=5`;
      const response = await fetch(url, {
        signal: AbortSignal.timeout(7000),
      });
      if (!response.ok) throw new Error("Search is currently unavailable.");
      const data: {
        features?: Array<{
          id: string;
          place_name?: string;
          center?: number[];
        }>;
      } = await response.json();
      const candidates: PlaceResult[] = (data.features ?? [])
        .filter((item) => item.center?.length === 2)
        .map((item) => ({
          id: item.id,
          name: item.place_name || "Unnamed location",
          lng: item.center![0],
          lat: item.center![1],
        }));
      setResults(candidates);
      if (!candidates.length)
        setSearchMessage("No matching Philippine locations were found.");
    } catch (error) {
      if (
        error instanceof DOMException &&
        (error.name === "TimeoutError" || error.name === "AbortError")
      ) {
        setSearchMessage("Location search timed out. Please try again.");
      } else {
        setSearchMessage("Unable to search locations right now.");
      }
    } finally {
      setSearching(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#F8FAF6] text-[#141414]">
      <header className="sticky top-0 z-50 flex h-20 items-center border-b border-[#E5EAE3] bg-white shadow-sm">
        {/* Match the 72px collapsed rail, so the hamburger and sidebar icons
            share the same horizontal center (36px from the left edge). */}
        <div className="flex h-full w-[72px] shrink-0 items-center justify-center">
          <button
            type="button"
            aria-label="Toggle navigation sidebar"
            aria-controls="sitesuri-sidebar"
            aria-expanded={sidebarExpanded || mobileSidebarOpen}
            onClick={() => {
              if (window.matchMedia("(min-width: 768px)").matches) {
                setSidebarExpanded((value) => !value);
              } else {
                setMobileSidebarOpen((value) => !value);
              }
            }}
            className="grid size-11 shrink-0 place-items-center rounded-xl text-[#354138] transition hover:bg-[#F2F5F0] focus-visible:outline-2 focus-visible:outline-brand-green"
          >
            {mobileSidebarOpen ? (
              <X size={22} aria-hidden="true" className="md:hidden" />
            ) : (
              <Menu size={22} aria-hidden="true" className="md:hidden" />
            )}
            <Menu size={22} aria-hidden="true" className="hidden md:block" />
          </button>
        </div>

        <div className="flex min-w-0 flex-1 items-center justify-between gap-4 px-4 sm:px-6 lg:px-9">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-yellow text-brand-black">
              <MapPinned size={21} aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <p className="font-display truncate text-lg font-extrabold tracking-tight">
                Site<span className="text-brand-green">Suri</span>
              </p>
              <p className="hidden text-[11px] text-[#66736B] sm:block">
                {view === "analytics"
                  ? "Analytics"
                  : view === "saved"
                    ? "Saved locations"
                    : "Location explorer"}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <AccountMenu />
          </div>
        </div>
      </header>
      <div className="flex min-h-[calc(100dvh-5rem)]">
        <DashboardSidebar
          expanded={sidebarExpanded}
          mobileOpen={mobileSidebarOpen}
          onCloseMobile={() => setMobileSidebarOpen(false)}
          analyticsHref={
            `/dashboard/analytics?lat=${point.lat}&lng=${point.lng}` +
            `&radius=${radius}&category=${encodeURIComponent(category)}`
          }
        />

        <main className="min-w-0 flex-1">
          {view === "saved" ? (
            <SavedLocationsWorkspace />
          ) : view === "analytics" ? (
            <div>
              <nav
                aria-label="Analytics modes"
                className="flex flex-wrap gap-2 px-5 pt-5 lg:px-9"
              >
                <Link
                  href={`/dashboard/analytics?lat=${point.lat}&lng=${point.lng}&radius=${radius}&category=${encodeURIComponent(category)}`}
                  aria-current={analyticsMode === "area" ? "page" : undefined}
                  className={`rounded-xl px-4 py-2 text-sm font-semibold ${analyticsMode === "area" ? "bg-brand-yellow" : "bg-white hover:bg-[#EDF1EA]"}`}
                >
                  Area analytics
                </Link>
                <Link
                  href="/dashboard/analytics?mode=saved"
                  aria-current={analyticsMode === "saved" ? "page" : undefined}
                  className={`rounded-xl px-4 py-2 text-sm font-semibold ${analyticsMode === "saved" ? "bg-brand-yellow" : "bg-white hover:bg-[#EDF1EA]"}`}
                >
                  My locations analytics
                </Link>
              </nav>
              {analyticsMode === "saved" ? (
                <SavedLocationsAnalytics
                  savedIds={savedIds}
                  initialCategory={category}
                />
              ) : (
                <AnalyticsOverview
                  api={api}
                  category={category}
                  radius={radius}
                  candidates={rankedCandidates}
                  selectedLocationId={selectedLocation?.location_id ?? null}
                  onSelectLocation={handleSelectLocation}
                  onCategoryChange={setCategory}
                />
              )}
            </div>
          ) : (
            <div className="mx-auto max-w-[1600px] space-y-6 p-5 lg:p-9">
              <div className="flex flex-wrap items-end justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2 text-xs font-extrabold uppercase tracking-[0.14em] text-brand-green">
                    Geographic research
                  </div>
                  <h2 className="font-display mt-2 text-3xl font-extrabold tracking-[-0.04em] sm:text-4xl">
                    Where could your business thrive?
                  </h2>
                  <p className="mt-2 text-sm text-[#66736B]">
                    Explore Philippine locations, then select a scored candidate
                    marker to review its precomputed suitability analysis.
                  </p>
                </div>
              </div>

              <div className="grid gap-5 xl:grid-cols-[330px_minmax(0,1fr)]">
                <div className="space-y-5">
                  <section
                    className="rounded-2xl border border-[#E6EAE3] bg-white p-5 shadow-sm"
                    aria-label="Analysis controls"
                  >
                    <div className="mb-5 flex items-center gap-2 font-bold">
                      <SlidersHorizontal
                        size={18}
                        className="text-brand-green"
                      />{" "}
                      Set analysis criteria
                    </div>
                    <form onSubmit={searchLocation} className="space-y-2">
                      <label
                        htmlFor="location-search"
                        className="text-xs font-bold text-[#4E5B52]"
                      >
                        Search an address or landmark
                      </label>
                      <div className="flex gap-2">
                        <input
                          id="location-search"
                          value={searchTerm}
                          onChange={(event) =>
                            setSearchTerm(event.target.value)
                          }
                          maxLength={200}
                          placeholder="e.g., Sampaloc, Manila"
                          className="min-w-0 flex-1 rounded-xl border border-[#DDE4DC] bg-[#FAFBF9] px-3 py-3 text-sm outline-none focus:border-brand-green"
                        />
                        <button
                          type="submit"
                          disabled={searching}
                          aria-label="Search location"
                          className="grid size-11 shrink-0 place-items-center rounded-xl bg-brand-yellow disabled:opacity-60"
                        >
                          <Search size={18} />
                        </button>
                      </div>
                      {searchMessage && (
                        <p
                          role="status"
                          className="text-xs leading-5 text-[#865F00]"
                        >
                          {searchMessage}
                        </p>
                      )}
                      {results.length > 0 && (
                        <ul className="max-h-48 space-y-1 overflow-auto rounded-xl border border-[#E2E6DE] p-1">
                          {results.map((place) => (
                            <li key={place.id}>
                              <button
                                type="button"
                                className="w-full rounded-lg px-3 py-2 text-left text-xs hover:bg-[#F5F5EF]"
                                onClick={() => {
                                  handlePickPoint({
                                    lat: place.lat,
                                    lng: place.lng,
                                  });
                                  setResults([]);
                                  setSearchTerm(place.name);
                                }}
                              >
                                {place.name}
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </form>
                    <div className="mt-6">
                      <CustomSelect
                        id="business-category"
                        label="Business category"
                        value={category}
                        onValueChange={(value) => {
                          if (isBusinessType(value)) setCategory(value);
                        }}
                        options={BUSINESS_CATEGORY_OPTIONS}
                      />
                    </div>
                    <div className="mt-6">
                      <CustomSelect
                        id="analysis-radius"
                        label="Analysis radius"
                        value={String(radius)}
                        onValueChange={(value) => setRadius(Number(value))}
                        options={RADIUS_OPTIONS}
                      />
                    </div>
                    <div className="mt-6 rounded-xl bg-[#F6F8F3] p-4">
                      <p className="text-[11px] font-bold uppercase tracking-wider text-[#68756D]">
                        Selected coordinates
                      </p>
                      <p className="mt-2 font-mono text-sm font-semibold">
                        {point.lat.toFixed(6)}, {point.lng.toFixed(6)}
                      </p>
                      <p className="mt-1 text-xs text-[#718076]">
                        {selectedLocation
                          ? `Scored candidate: ${selectedLocation.address ?? selectedLocation.source_location_id ?? selectedLocation.location_id}`
                          : "Click a candidate marker to enable analysis. Free-picked coordinates are for exploration only."}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={handleAnalyze}
                      disabled={
                        !hasBackend ||
                        !appUser ||
                        !selectedLocation ||
                        analysisMutation.isPending
                      }
                      className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl bg-[#171717] px-4 py-3 text-sm font-bold text-white transition hover:bg-brand-green disabled:cursor-not-allowed disabled:opacity-55"
                    >
                      {analysisMutation.isPending
                        ? "Analyzing location..."
                        : "Analyze location"}
                      <ArrowRight size={16} aria-hidden="true" />
                    </button>
                    <div
                      role="status"
                      aria-live="polite"
                      className="mt-2 text-center text-[11px] leading-5 text-[#7A877E]"
                    >
                      {currentAnalysisError ? (
                        <p className="text-red-700">
                          {getApiErrorMessage(
                            currentAnalysisError,
                            "Could not analyze this location.",
                          )}
                        </p>
                      ) : !selectedLocation ? (
                        <p>Select an available candidate marker to analyze.</p>
                      ) : analysisMutation.isPending ? (
                        <p>Requesting the saved model score...</p>
                      ) : (
                        <p>
                          Precomputed synthetic score; not a live prediction.
                        </p>
                      )}
                    </div>
                  </section>

                  <section className="rounded-2xl border border-[#E5EAE4] bg-white p-5 shadow-sm">
                    <h3 className="text-sm font-extrabold">
                      Account connection
                    </h3>

                    <p className="mt-1 text-xs text-[#78847C]">
                      Clerk session → FastAPI → Supabase
                    </p>

                    <div
                      role="status"
                      className="mt-3 text-xs leading-5 text-[#425348]"
                    >
                      {!hasBackend ? (
                        <p>Backend not configured. Add NEXT_PUBLIC_API_URL.</p>
                      ) : accountLoading || (!appUser && !accountError) ? (
                        <p>Synchronizing your profile...</p>
                      ) : accountError ? (
                        <div className="space-y-2">
                          <p className="text-red-600">
                            Unable to synchronize your account.
                          </p>

                          <button
                            type="button"
                            onClick={retrySync}
                            className="font-semibold text-brand-green hover:underline"
                          >
                            Retry connection
                          </button>
                        </div>
                      ) : appUser ? (
                        <div className="space-y-1">
                          <p className="font-semibold text-brand-green">
                            Connected to FastAPI and Supabase
                          </p>
                          <p>{appUser.email ?? "No email available"}</p>
                        </div>
                      ) : (
                        <p>Waiting for account information...</p>
                      )}
                    </div>
                  </section>
                </div>

                <div className="space-y-5">
                  <div className="h-[480px] overflow-hidden rounded-2xl bg-white shadow-sm lg:h-[600px]">
                    <MemoizedMapWorkspace
                      point={point}
                      radiusMeters={radius}
                      onPickPoint={handlePickPoint}
                      locations={nearbyCandidates.map(
                        ({ location }) => location,
                      )}
                      selectedLocationId={selectedLocation?.location_id ?? null}
                      onLocationSelect={handleSelectLocation}
                      scoresByLocationId={scoresByLocationId}
                    />
                  </div>

                  <section className="rounded-2xl border border-[#E5EAE4] bg-white p-5">
                    <h3 className="font-bold">Nearby candidate locations</h3>

                    <p className="mt-1 text-sm text-[#66736B]">
                      {rankedCandidates.length} locations within{" "}
                      {radius.toLocaleString()} meters
                    </p>

                    <div className="mt-4 space-y-3">
                      {rankedCandidates.map((candidate) => {
                        const locationId = candidate.location.location_id;

                        const bookmarked = savedByCandidate.get(
                          savedKey(locationId, category),
                        );

                        return (
                          <CandidateLocationCard
                            key={locationId}
                            location={candidate.location}
                            businessType={category}
                            distance={candidate.distance}
                            score={candidate.score}
                            scoreDetails={candidate.scoreDetails}
                            isLoading={candidate.isLoading}
                            isError={candidate.isError}
                            isSelected={
                              selectedLocation?.location_id === locationId
                            }
                            isExpanded={expandedLocationId === locationId}
                            bookmarked={Boolean(bookmarked)}
                            bookmarkPending={bookmarkMutation.isPending}
                            bookmarkDisabled={
                              !appUser ||
                              !hasBackend ||
                              bookmarkMutation.isPending ||
                              savedLocationsQuery.isPending ||
                              savedLocationsQuery.isError
                            }
                            analysisDisabled={
                              !appUser ||
                              !hasBackend ||
                              analysisMutation.isPending ||
                              candidate.isError ||
                              !candidate.scoreDetails
                            }
                            onSelect={() =>
                              setSelectedLocation(candidate.location)
                            }
                            onToggle={() =>
                              setExpandedLocationId((previous) =>
                                previous === locationId ? null : locationId,
                              )
                            }
                            onAnalyze={() =>
                              handleAnalyzeCandidate(candidate.location)
                            }
                            onBookmark={() =>
                              bookmarkMutation.mutate({
                                locationId,
                                savedId: bookmarked?.id,
                              })
                            }
                          />
                        );
                      })}
                    </div>

                    {bookmarkMutation.isError && (
                      <p role="alert" className="mt-3 text-xs text-red-700">
                        Could not update your saved locations. Please try again.
                      </p>
                    )}
                    {savedLocationsQuery.isError && (
                      <p role="alert" className="mt-3 text-xs text-red-700">
                        Could not load bookmark status. Refresh to retry.
                      </p>
                    )}

                    {rankedCandidates.length === 0 && (
                      <p className="mt-4 text-sm text-[#66736B]">
                        No candidate locations within this radius. Try
                        increasing the search area.
                      </p>
                    )}
                  </section>

                  <div
                    role="status"
                    aria-live="polite"
                    className="text-xs leading-5 text-[#647369]"
                  >
                    {locationsQuery.isPending && hasBackend ? (
                      <p>Loading scored candidate locations...</p>
                    ) : locationsQuery.isError ? (
                      <div className="flex flex-wrap items-center gap-3 text-red-700">
                        <span>
                          {getApiErrorMessage(
                            locationsQuery.error,
                            "Could not load candidate locations.",
                          )}
                        </span>
                        <button
                          type="button"
                          onClick={() => void locationsQuery.refetch()}
                          className="font-bold underline"
                        >
                          Retry
                        </button>
                      </div>
                    ) : locationsQuery.isSuccess ? (
                      <p>
                        {locationsQuery.data.length.toLocaleString()} candidate
                        locations available · Select a colored marker to
                        analyze.
                      </p>
                    ) : !hasBackend ? (
                      <p>
                        Configure NEXT_PUBLIC_API_URL to load candidate
                        locations.
                      </p>
                    ) : null}
                  </div>

                  <div className="grid gap-4 sm:grid-cols-3">
                    <div className="rounded-2xl border border-[#E5EAE4] bg-white p-5">
                      <p className="text-xs text-[#6B786F]">Business type</p>
                      <p className="mt-2 text-xl font-bold capitalize">
                        {category}
                      </p>
                    </div>
                    <div className="rounded-2xl border border-[#E5EAE4] bg-white p-5">
                      <p className="text-xs text-[#6B786F]">Analysis radius</p>
                      <p className="mt-2 text-xl font-bold">
                        {radius.toLocaleString()} m
                      </p>
                    </div>
                    <div className="rounded-2xl border border-[#E5EAE4] bg-white p-5">
                      <p className="text-xs text-[#6B786F]">
                        Suitability score
                      </p>
                      <p className="mt-2 text-xl font-bold text-[#8A948C]">
                        {score
                          ? `${score.location_score.toFixed(1)}/100`
                          : "Not analyzed"}
                      </p>
                    </div>
                  </div>
                  {activeAnalysis && score && (
                    <section
                      ref={analysisResultRef}
                      aria-label="Location suitability analysis"
                      className="scroll-mt-24 space-y-5 rounded-2xl border border-[#E5EAE4] bg-white p-5 shadow-sm"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <h3 className="text-lg font-extrabold">
                            Suitability breakdown
                          </h3>
                          <p className="mt-1 text-xs text-[#6B786F]">
                            {selectedLocation?.address ??
                              selectedLocation?.source_location_id ??
                              "Selected candidate"}{" "}
                            · {category}
                          </p>
                        </div>
                        <span className="rounded-full bg-[#E9F6E9] px-3 py-1 text-xs font-bold text-brand-green">
                          {score.location_score.toFixed(1)}/100
                        </span>
                      </div>

                      <div className="grid gap-4 sm:grid-cols-2">
                        {score.components.map((component) => (
                          <div
                            key={component.name}
                            className="space-y-2 rounded-xl bg-[#F6F8F3] p-4"
                          >
                            <div className="flex items-center justify-between gap-3 text-sm">
                              <p className="font-semibold">{component.name}</p>
                              <p className="shrink-0 font-bold">
                                {typeof component.score === "number"
                                  ? `${component.score.toFixed(1)}/100`
                                  : "N/A"}
                              </p>
                            </div>
                            {typeof component.score === "number" && (
                              <div className="h-2 overflow-hidden rounded-full bg-[#DEE4DC]">
                                <div
                                  className="h-full rounded-full bg-brand-green"
                                  style={{
                                    width: `${Math.max(0, Math.min(100, component.score))}%`,
                                  }}
                                />
                              </div>
                            )}
                            {typeof component.weight === "number" && (
                              <p className="text-xs text-[#68756D]">
                                Weight: {(component.weight * 100).toFixed(0)}%
                              </p>
                            )}
                          </div>
                        ))}
                      </div>

                      {score.weakest_component && (
                        <p className="text-sm text-[#4E5B52]">
                          <span className="font-bold">Weakest component:</span>{" "}
                          {score.weakest_component}
                        </p>
                      )}

                      {score.flags.length > 0 && (
                        <div className="space-y-2">
                          <h4 className="text-sm font-bold">Considerations</h4>
                          <ul className="list-inside list-disc space-y-1 text-sm text-[#4E5B52]">
                            {score.flags.map((flag, index) => (
                              <li key={`${index}-${flag}`}>
                                {formatModelFlag(flag)}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {score.caps_applied.length > 0 && (
                        <p className="text-xs text-[#865F00]">
                          Score caps applied: {score.caps_applied.join(", ")}
                        </p>
                      )}

                      <p className="border-t border-[#E5EAE4] pt-3 text-xs leading-5 text-[#6B786F]">
                        Source: {activeAnalysis.source_type} · Method:{" "}
                        {activeAnalysis.prediction_mode}. The displayed{" "}
                        {radius.toLocaleString()} m radius is a visualization
                        setting; the stored score was precomputed for this
                        candidate and business category.
                      </p>
                    </section>
                  )}

                  <div className="flex items-start gap-3 rounded-xl border border-[#F1DEA6] bg-[#FFF9E5] px-5 py-4 text-sm text-[#685721]">
                    <ShieldCheck className="mt-0.5 shrink-0" size={18} />
                    <p>
                      SiteSuri's available suitability results come from a
                      synthetic prototype dataset. They are not observed
                      pedestrian counts, live conditions, or guaranteed business
                      outcomes. Arbitrary map points have no precomputed score.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

export default function DashboardClient(props: DashboardClientProps) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { refetchOnWindowFocus: false } },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      <DashboardContent {...props} />
    </QueryClientProvider>
  );
}
