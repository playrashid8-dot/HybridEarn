"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { checkAdminSession, isAuth } from "../lib/auth";
import PageSkeleton from "./Skeleton";

export default function ProtectedRoute({
  children,
  adminOnly = false,
}: {
  children: ReactNode;
  adminOnly?: boolean;
}) {
  const router = useRouter();
  const [checking, setChecking] = useState(true);
  const [redirecting, setRedirecting] = useState(false);

  useEffect(() => {
    let mounted = true;

    const verifyAuth = async () => {
      try {
        const ok = await isAuth();

        if (!mounted) return;

        const admin = adminOnly ? await checkAdminSession() : false;

        if (!mounted) return;

        if (!ok) {
          setRedirecting(true);
          router.replace("/login");
        } else if (adminOnly && !admin) {
          setRedirecting(true);
          router.replace("/dashboard");
        } else {
          setChecking(false);
        }
      } catch {
        setRedirecting(true);
        router.replace("/login");
      }
    };

    verifyAuth();

    return () => {
      mounted = false;
    };
  }, [adminOnly, router]);

  if (checking || redirecting) {
    return (
      <div className="w-full px-3 pb-24 pt-4 sm:px-6" aria-busy aria-label="Loading page">
        <PageSkeleton />
      </div>
    );
  }

  return <>{children}</>;
}
