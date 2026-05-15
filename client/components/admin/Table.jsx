"use client";

import React from "react";

export default function Table({ columns, children, emptyText = "No records found", footer }) {
  const hasRows = React.Children.count(children) > 0;

  return (
    <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.04]">
      <div className="max-h-[min(70vh,780px)] overflow-y-auto overscroll-contain">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-white/10 text-left text-sm">
            <thead className="sticky top-0 z-10 bg-[#14141c]/95 backdrop-blur-sm text-xs uppercase tracking-wide text-gray-400">
              <tr>
                {columns.map((column) => (
                  <th key={column} className="whitespace-nowrap px-4 py-3 font-medium">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-white/10">
              {hasRows ? (
                children
              ) : (
                <tr>
                  <td className="px-4 py-8 text-center text-gray-400" colSpan={columns.length}>
                    {emptyText}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      {footer}
    </div>
  );
}
