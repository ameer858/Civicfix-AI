import { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { AlertTriangle, Layers, MapPin, Navigation } from 'lucide-react';
import { clusterHotspots } from '../lib/intelligenceEngine';
import { useLanguage } from '../context/LanguageContext';
import { PriorityIndicator, StatusIndicator } from './StatusBadge';
import { formatTimestamp } from './WorkflowTimeline';
import {
  CATEGORY_LABELS,
  PRIORITY_LABELS,
  type CivicReport,
  type HotspotCluster,
  type IssueCategory,
  type IssuePriority,
} from '../types/civic';

interface HotspotMapViewProps {
  reports: CivicReport[];
  onSelectReport?: (reportId: string) => void;
}

const PRIORITY_COLOR: Record<IssuePriority, string> = {
  critical: '#b91c1c',
  high: '#d97706',
  medium: '#1d4ed8',
  low: '#475569',
};

export function HotspotMapView({ reports, onSelectReport }: HotspotMapViewProps) {
  const { t, tCategory, tPriority, tStatus, locale } = useLanguage();
  const [categoryFilter, setCategoryFilter] = useState<IssueCategory | 'all'>('all');
  const [priorityFilter, setPriorityFilter] = useState<IssuePriority | 'all'>('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [radiusMeters, setRadiusMeters] = useState<number>(350);
  const [selectedClusterId, setSelectedClusterId] = useState<string | null>(null);
  const [tileWarning, setTileWarning] = useState(false);

  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);
  const layerGroupRef = useRef<L.LayerGroup | null>(null);

  const { validLocationReports, missingLocationReports, clusters } = useMemo(
    () =>
      clusterHotspots(
        reports,
        {
          category: categoryFilter,
          priority: priorityFilter,
          dateFromIso: dateFrom || undefined,
          dateToIso: dateTo || undefined,
        },
        radiusMeters
      ),
    [reports, categoryFilter, priorityFilter, dateFrom, dateTo, radiusMeters]
  );

  const recurringZonesCount = useMemo(
    () => clusters.filter((c) => c.isRecurringZone).length,
    [clusters]
  );

  const selectedCluster: HotspotCluster | null = useMemo(() => {
    if (clusters.length === 0) return null;
    if (selectedClusterId) {
      const found = clusters.find((c) => c.clusterId === selectedClusterId);
      if (found) return found;
    }
    return clusters[0];
  }, [clusters, selectedClusterId]);

  useEffect(() => {
    const container = mapContainerRef.current;
    if (!container) return;

    if (!mapInstanceRef.current) {
      const map = L.map(container, {
        center: [20, 0],
        zoom: 2,
        scrollWheelZoom: true,
      });

      const tileLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors',
        maxZoom: 19,
      });

      tileLayer.on('tileerror', () => {
        setTileWarning(true);
      });

      tileLayer.addTo(map);
      const group = L.layerGroup().addTo(map);

      mapInstanceRef.current = map;
      layerGroupRef.current = group;
    }

    return () => {
      if (mapInstanceRef.current) {
        mapInstanceRef.current.remove();
        mapInstanceRef.current = null;
        layerGroupRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const map = mapInstanceRef.current;
    const group = layerGroupRef.current;
    if (!map || !group) return;

    group.clearLayers();

    if (clusters.length === 0) {
      map.setView([20, 0], 2);
      return;
    }

    const bounds = L.latLngBounds([]);

    for (const cluster of clusters) {
      const latLng: [number, number] = [cluster.centroidLat, cluster.centroidLng];
      bounds.extend(latLng);

      const isSelected = selectedCluster?.clusterId === cluster.clusterId;
      const fillColor = cluster.isRecurringZone
        ? '#ea580c'
        : PRIORITY_COLOR[cluster.highestPriority] || '#1d4ed8';
      const radiusPx = Math.min(24, 8 + cluster.reportCount * 3);

      const marker = L.circleMarker(latLng, {
        radius: radiusPx,
        color: isSelected ? '#0f172a' : '#ffffff',
        weight: isSelected ? 3 : 2,
        fillColor,
        fillOpacity: 0.85,
      });

      const safeTitle = cluster.areaLabel.replace(/[<>&"]/g, '');
      marker.bindTooltip(
        `${t('map.zoneDetailsCount', { count: cluster.reportCount })} · ${safeTitle}${
          cluster.isRecurringZone ? ` (${t('map.recurringZoneBadge')})` : ''
        }`,
        { direction: 'top' }
      );

      marker.on('click', () => {
        setSelectedClusterId(cluster.clusterId);
      });

      marker.addTo(group);
    }

    if (clusters.length === 1) {
      map.setView([clusters[0].centroidLat, clusters[0].centroidLng], 15);
    } else if (bounds.isValid()) {
      map.fitBounds(bounds.pad(0.22), { maxZoom: 15 });
    }
  }, [clusters, selectedCluster?.clusterId, t]);

  return (
    <div className="space-y-6">
      {/* Filter Toolbar */}
      <section className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <MapPin className="w-4 h-4 text-blue-700" aria-hidden="true" />
            <h2 className="text-sm font-semibold text-slate-900">
              {t('map.title')}
            </h2>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs font-mono tabular-nums text-slate-600">
            <span>{t('map.mappedReports', { count: validLocationReports.length })}</span>
            <span>{t('map.zones', { count: clusters.length })}</span>
            <span className="text-orange-700 font-semibold">
              {t('map.recurringZones', { count: recurringZonesCount })}
            </span>
            {missingLocationReports.length > 0 && (
              <span className="text-amber-700 font-semibold">
                {t('map.missingCoords', { count: missingLocationReports.length })}
              </span>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          <div>
            <label className="block text-[11px] font-medium text-slate-600 mb-1">
              {t('common.category')}
            </label>
            <select
              aria-label={t('common.category')}
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value as IssueCategory | 'all')}
              className="w-full px-2.5 py-2 rounded-lg border border-slate-300 text-xs bg-white"
            >
              <option value="all">{t('common.allCategories')}</option>
              {(Object.keys(CATEGORY_LABELS) as IssueCategory[]).map((cat) => (
                <option key={cat} value={cat}>
                  {tCategory(cat)}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-[11px] font-medium text-slate-600 mb-1">
              {t('common.priority')}
            </label>
            <select
              aria-label={t('common.priority')}
              value={priorityFilter}
              onChange={(e) => setPriorityFilter(e.target.value as IssuePriority | 'all')}
              className="w-full px-2.5 py-2 rounded-lg border border-slate-300 text-xs bg-white"
            >
              <option value="all">{t('common.allPriorities')}</option>
              {(Object.keys(PRIORITY_LABELS) as IssuePriority[]).map((p) => (
                <option key={p} value={p}>
                  {tPriority(p)}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-[11px] font-medium text-slate-600 mb-1">
              {t('map.fromDate')}
            </label>
            <input
              type="date"
              aria-label={t('map.fromDate')}
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs bg-white font-mono"
            />
          </div>

          <div>
            <label className="block text-[11px] font-medium text-slate-600 mb-1">
              {t('map.toDate')}
            </label>
            <input
              type="date"
              aria-label={t('map.toDate')}
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs bg-white font-mono"
            />
          </div>

          <div>
            <label className="block text-[11px] font-medium text-slate-600 mb-1">
              {t('map.clusterRadius')}
            </label>
            <select
              aria-label={t('map.clusterRadius')}
              value={radiusMeters}
              onChange={(e) => setRadiusMeters(Number(e.target.value))}
              className="w-full px-2.5 py-2 rounded-lg border border-slate-300 text-xs bg-white"
            >
              <option value={0}>{t('map.radius0')}</option>
              <option value={200}>{t('map.radius200')}</option>
              <option value={350}>{t('map.radius350')}</option>
              <option value={750}>{t('map.radius750')}</option>
            </select>
          </div>
        </div>
      </section>

      {/* Interactive Leaflet Map + Selected Cluster Inspector */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <section className="lg:col-span-7 bg-white border border-slate-200 rounded-xl overflow-hidden flex flex-col">
          <div className="px-4 py-3 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="font-semibold text-slate-900 flex items-center gap-1.5">
              <Navigation className="w-3.5 h-3.5 text-blue-700" aria-hidden="true" />
              {t('map.interactiveMapTitle')}
            </span>
            <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-600">
              <span className="inline-flex items-center gap-1">
                <span className="w-2.5 h-2.5 rounded-full bg-orange-600 inline-block" />
                {t('map.legendRecurring')}
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="w-2.5 h-2.5 rounded-full bg-blue-700 inline-block" />
                {t('map.legendSingle')}
              </span>
            </div>
          </div>

          {tileWarning && (
            <div className="px-4 py-2 bg-amber-50 border-b border-amber-200 text-xs text-amber-900">
              {t('map.tileWarning')}
            </div>
          )}

          <div className="relative h-[420px] w-full bg-slate-100">
            <div ref={mapContainerRef} className="h-full w-full z-0" />
            {validLocationReports.length === 0 && (
              <div className="absolute inset-0 z-10 bg-white/85 flex items-center justify-center p-6 text-center">
                <div className="max-w-sm space-y-1.5">
                  <MapPin className="w-6 h-6 text-slate-400 mx-auto" aria-hidden="true" />
                  <p className="text-sm font-medium text-slate-900">
                    {t('map.noCoordsTitle')}
                  </p>
                  <p className="text-xs text-slate-600">
                    {t('map.noCoordsDesc')}
                  </p>
                </div>
              </div>
            )}
          </div>
        </section>

        <section className="lg:col-span-5 bg-white border border-slate-200 rounded-xl flex flex-col max-h-[472px]">
          <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <Layers className="w-4 h-4 text-blue-700 shrink-0" aria-hidden="true" />
              <h3 className="text-sm font-semibold text-slate-900 truncate">
                {selectedCluster
                  ? t('map.zoneDetailsCount', { count: selectedCluster.reportCount })
                  : t('map.zoneDetails')}
              </h3>
            </div>
            {selectedCluster?.isRecurringZone && (
              <span className="text-[11px] font-medium text-orange-800 bg-orange-50 border border-orange-200 px-2 py-0.5 rounded whitespace-nowrap">
                {t('map.recurringZoneBadge')}
              </span>
            )}
          </div>

          {!selectedCluster ? (
            <div className="p-8 text-center text-xs text-slate-500">
              {t('map.selectMarkerHint')}
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto divide-y divide-slate-200">
              <div className="px-5 py-3 bg-slate-50/70 text-xs space-y-1">
                <p className="font-medium text-slate-900">{selectedCluster.areaLabel}</p>
                <p className="font-mono tabular-nums text-slate-500">
                  {t('map.centroid')}: {selectedCluster.centroidLat.toFixed(5)},{' '}
                  {selectedCluster.centroidLng.toFixed(5)} · {t('map.dominant')}:{' '}
                  {tCategory(selectedCluster.dominantCategory)}
                </p>
              </div>

              {selectedCluster.reports.map((rep) => (
                <div key={rep.id} className="p-4 space-y-2 text-xs">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-mono tabular-nums text-slate-500">{rep.trackingCode}</p>
                      <p className="font-semibold text-slate-900 truncate">{rep.title}</p>
                    </div>
                    <PriorityIndicator priority={rep.priority} />
                  </div>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-slate-600">
                    <span>{tCategory(rep.category)}</span>
                    <span aria-hidden="true">·</span>
                    <StatusIndicator status={rep.status} />
                  </div>
                  <p className="text-slate-600 truncate">{rep.addressText}</p>
                  <div className="flex items-center justify-between pt-1">
                    <span className="font-mono tabular-nums text-[11px] text-slate-400">
                      {formatTimestamp(rep.createdAt, locale)}
                    </span>
                    {onSelectReport && (
                      <button
                        type="button"
                        onClick={() => onSelectReport(rep.id)}
                        className="px-2.5 py-1 rounded border border-slate-300 bg-white text-xs font-medium text-blue-700 hover:bg-blue-50 whitespace-nowrap"
                      >
                        {t('map.openReport')}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {/* Reports Without Valid Coordinates (Honesty Guardrail) */}
      <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-5 py-3.5 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-600" aria-hidden="true" />
            <h3 className="text-sm font-semibold text-slate-900">
              {t('map.missingTableTitle', { count: missingLocationReports.length })}
            </h3>
          </div>
          <span className="text-xs text-slate-500">
            {t('map.missingTableNote')}
          </span>
        </div>

        {missingLocationReports.length === 0 ? (
          <p className="px-5 py-4 text-xs text-slate-500">
            {t('map.allValidCoords')}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
                  <th className="py-2.5 px-5 font-medium">{t('common.trackingId')}</th>
                  <th className="py-2.5 px-4 font-medium">{t('map.colIssue')}</th>
                  <th className="py-2.5 px-4 font-medium">{t('map.colRecordedAddress')}</th>
                  <th className="py-2.5 px-4 font-medium">{t('common.status')}</th>
                  <th className="py-2.5 px-5 font-medium text-right">{t('common.action')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {missingLocationReports.map((r) => (
                  <tr key={r.id} className="hover:bg-slate-50">
                    <td className="py-2.5 px-5 font-mono tabular-nums text-slate-700">
                      {r.trackingCode}
                    </td>
                    <td className="py-2.5 px-4 font-medium text-slate-900">{r.title}</td>
                    <td className="py-2.5 px-4 text-slate-600">{r.addressText || t('map.noAddress')}</td>
                    <td className="py-2.5 px-4 text-slate-700">{tStatus(r.status)}</td>
                    <td className="py-2.5 px-5 text-right">
                      {onSelectReport && (
                        <button
                          type="button"
                          onClick={() => onSelectReport(r.id)}
                          className="text-blue-700 font-medium hover:underline"
                        >
                          {t('common.inspect')}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
