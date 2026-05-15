"use client";

import EmptyState from "./EmptyState";
import PageSkeleton from "./Skeleton";

/**
 * @param {{
 *   loading?: boolean;
 *   data?: unknown;
 *   skipEmpty?: boolean;
 *   emptyText?: string;
 *   children: React.ReactNode;
 * }} props
 */
export default function PageWrapper({
  loading,
  data,
  skipEmpty = false,
  emptyText = "No data available",
  children,
}) {
  if (loading) {
    return <PageSkeleton />;
  }

  const isDataEmpty =
    !data ||
    (Array.isArray(data) && data.length === 0) ||
    (typeof data === "object" &&
      data !== null &&
      !Array.isArray(data) &&
      Object.keys(data).length === 0);

  if (!skipEmpty && isDataEmpty) {
    return <EmptyState text={emptyText} />;
  }
  return children;
}
