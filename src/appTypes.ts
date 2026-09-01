export interface AppSummary {
  trackId: string;
  trackName: string;
  trackViewUrl: string;
  sellerName: string;
  currency: string;
  formattedPrice: string;
  price: number;
  averageUserRating: number;
  userRatingCount: number;
  fileSizeBytes: string;
  currentVersionReleaseDate: string;
  minimumOsVersion: string;
  version: string;
  primaryGenreName: string;
}

export interface AppSelectionActions {
  inAppPurchase: string;
  priceCompare: string;
}

export interface AppSelection {
  app: AppSummary;
  query: string;
  storefront: "us";
  actions: AppSelectionActions;
  createdAt: number;
}
