import { useMemo } from 'react';
import { useWindowDimensions } from 'react-native';
import { useStore } from '../store/useStore';

export const MOBILE_BREAKPOINT = 768;
export const TABLET_BREAKPOINT = 1180;
const TV_LAYOUT_ASPECT_RATIO = 16 / 10;

export const useResponsiveLayout = () => {
  const { width: rawWidth, height: rawHeight } = useWindowDimensions();
  const isTvMode = useStore((state) => state.isTvMode);

  return useMemo(() => {
    // Keep real CSS viewport dimensions for sizing. We only normalize
    // breakpoints for TV to avoid mobile/tablet branches on 10-foot UIs.
    const width = rawWidth;
    const height = rawHeight;

    const shortestSide = Math.min(width, height);
    const longestSide = Math.max(width, height);
    const isLandscape = width >= height;
    const isTvProfile = isTvMode && isLandscape;
    const contentMaxWidth = isTvProfile
      ? Math.min(width, Math.round(height * TV_LAYOUT_ASPECT_RATIO))
      : width;
    const contentHorizontalGutter = isTvProfile
      ? Math.max(0, Math.round((width - contentMaxWidth) / 2))
      : 0;
    const normalizedShortestSide =
      isTvProfile ? Math.max(shortestSide, 1080) : shortestSide;

    const isMobile = normalizedShortestSide < MOBILE_BREAKPOINT;
    const isTablet =
      normalizedShortestSide >= MOBILE_BREAKPOINT && normalizedShortestSide < TABLET_BREAKPOINT;
    const isDesktop = !isMobile && !isTablet;
    const isCompact = longestSide < 1500 || height < 840;

    const rawScale = longestSide / 1366;
    const uiScale = isTvProfile
      ? 0.88
      : Math.max(0.92, Math.min(1.1, rawScale));

    const sideRailCollapsedWidth = isTvProfile
      ? 72
      : isLandscape
        ? (isMobile ? 72 : 80)
        : 72;
    const sideRailExpandedWidth = isTvProfile
      ? 256
      : sideRailCollapsedWidth + (isMobile ? 168 : 196);
    const horizontalPadding = isTvProfile
      ? 20 // Fixo menor
      : isMobile
        ? 16
        : isTablet
          ? Math.round(24 * uiScale)
          : Math.round(32 * uiScale);
    const topHeaderPadding = isTvProfile ? 18 : isMobile ? 20 : Math.round(28 * uiScale);
    const bottomNavigationHeight = isMobile && !isTvMode ? 78 : 0;
    const heroHeightMax = isTvProfile ? 900 : isMobile ? 420 : 680;
    const heroHeightRatio = isTvProfile ? 0.66 : isMobile ? 0.58 : 0.66;
    const heroMinHeight = isTvProfile ? 480 : isMobile ? 300 : 390;
    const heroContentMaxWidth = isTvProfile ? 760 : 760;
    const heroTitleSize = isTvProfile ? 24 : isMobile ? 22 : isTablet ? 30 : 34;
    const heroMetaSize = isTvProfile ? 12 : isMobile ? 12 : 14;
    const heroButtonFontSize = isTvProfile ? 13 : isMobile ? 13 : 15;
    const rowCardWidth = isTvProfile ? 110 : null;
    const rowCardGap = isTvProfile ? 12 : null;
    const gridCardMaxWidth = isTvProfile ? 152 : null;
    const menuLabelSize = isTvProfile ? 14 : 18;
    const menuIconSize = isTvProfile ? 20 : 22;

    return {
      width,
      height,
      contentMaxWidth,
      contentHorizontalGutter,
      isMobile,
      isTablet,
      isCompact,
      isDesktop,
      isLandscape,
      isTvMode,
      isTvProfile,
      uiScale,
      horizontalPadding,
      topHeaderPadding,
      sideRailWidth: sideRailCollapsedWidth,
      sideRailCollapsedWidth,
      sideRailExpandedWidth,
      bottomNavigationHeight,
      heroHeightMax,
      heroHeightRatio,
      heroMinHeight,
      heroContentMaxWidth,
      heroTitleSize,
      heroMetaSize,
      heroButtonFontSize,
      rowCardWidth,
      rowCardGap,
      gridCardMaxWidth,
      menuLabelSize,
      menuIconSize,
    };
  }, [rawHeight, isTvMode, rawWidth]);
};
