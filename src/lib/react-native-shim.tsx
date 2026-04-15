import React, { forwardRef, useState, useEffect } from 'react';

// === Utilities ===
const flattenStyle = (style: any): React.CSSProperties => {
  if (!style) return {};
  if (!Array.isArray(style)) return style as React.CSSProperties;
  
  return style.reduce((acc, curr) => {
    if (!curr) return acc;
    return { ...acc, ...flattenStyle(curr) };
  }, {} as React.CSSProperties);
};

// === Base View ===
export const View = forwardRef<HTMLDivElement, any>(({ style, pointerEvents, className, children, ...props }, ref) => {
  const pointerEventsStyle = pointerEvents ? { pointerEvents: (pointerEvents === 'none' ? 'none' : 'auto') as any } : {};
  const flatStyle = flattenStyle(style);
  
  return (
    <div 
      ref={ref} 
      style={{ display: 'flex', flexDirection: 'column', boxSizing: 'border-box', position: 'relative', border: '0 solid black', minWidth: 0, minHeight: 0, ...flatStyle, ...pointerEventsStyle }}
      className={className}
      {...props}
    >
      {children}
    </div>
  );
});
View.displayName = 'View';

// === Base Text ===
export const Text = forwardRef<HTMLSpanElement, any>(({ style, className, children, numberOfLines, ...props }, ref) => {
  const flatStyle = flattenStyle(style);
  const lineClamp = numberOfLines ? {
    display: '-webkit-box',
    WebkitLineClamp: numberOfLines,
    WebkitBoxOrient: 'vertical' as any,
    overflow: 'hidden'
  } : {};
  
  return (
    <span ref={ref} style={{ ...flatStyle, ...lineClamp }} className={className} {...props}>
      {children}
    </span>
  );
});
Text.displayName = 'Text';

// === Base Image ===
export const ImageBackground = forwardRef<HTMLDivElement, any>(({ style, source, className, imageStyle, children, ...props }, ref) => {
  const flatStyle = flattenStyle(style);
  const flatImageStyle = flattenStyle(imageStyle);
  const uri = typeof source === 'string' ? source : (source?.uri || '');
  const bgImage = uri ? `url(${uri})` : undefined;
  
  return (
    <div 
      ref={ref} 
      style={{ backgroundImage: bgImage, backgroundSize: 'cover', backgroundPosition: 'center', display: 'flex', flexDirection: 'column', position: 'relative', overflow: 'hidden', ...flatStyle }} 
      className={className} 
      {...props}
    >
      {/* Background layer to mimic ImageBackground implementation */}
      <div style={{ position: 'absolute', inset: 0, backgroundImage: bgImage, backgroundSize: 'cover', backgroundPosition: 'center', zIndex: -1, ...flatImageStyle }} />
      {children}
    </div>
  );
});
ImageBackground.displayName = 'ImageBackground';

export const Image = forwardRef<HTMLImageElement, any>(({ style, source, className, ...props }, ref) => {
  const flatStyle = flattenStyle(style);
  const uri = typeof source === 'string' ? source : (source?.uri || '');
  return <img ref={ref} src={uri} style={{ objectFit: 'cover', ...flatStyle }} className={className} {...props} />;
});
Image.displayName = 'Image';

// === Interactables ===
export const TouchableHighlight = forwardRef<HTMLDivElement, any>(({ style, onPress, onFocus, onBlur, className, children, underlayColor, ...props }, ref) => {
  const flatStyle = flattenStyle(style);
  return (
    <div 
      ref={ref} 
      onClick={onPress} 
      onFocus={onFocus}
      onBlur={onBlur}
      tabIndex={0}
      style={{ cursor: 'pointer', display: 'flex', flexDirection: 'column', position: 'relative', ...flatStyle }} 
      className={className} 
      {...props}
    >
      {children}
    </div>
  );
});
TouchableHighlight.displayName = 'TouchableHighlight';

export const TouchableOpacity = TouchableHighlight;

export const TextInput = forwardRef<HTMLInputElement, any>(({ style, className, onChangeText, secureTextEntry, value, ...props }, ref) => {
  const flatStyle = flattenStyle(style);
  return (
    <input 
      ref={ref} 
      type={secureTextEntry ? 'password' : 'text'}
      value={value}
      onChange={e => onChangeText?.(e.target.value)}
      style={{ ...flatStyle }} 
      className={className} 
      {...props} 
    />
  );
});
TextInput.displayName = 'TextInput';

// === Lists & Scrolling ===
export const FlatList = forwardRef<HTMLDivElement, any>(({ 
  data, 
  renderItem, 
  keyExtractor, 
  style, 
  contentContainerStyle, 
  ListHeaderComponent,
  horizontal,
  showsHorizontalScrollIndicator,
  ...props 
}, ref) => {
  const flatStyle = flattenStyle(style);
  const flatContainerStyle = flattenStyle(contentContainerStyle);

  return (
    <div 
      ref={ref} 
      style={{
        display: 'flex', 
        flexDirection: horizontal ? 'row' : 'column',
        overflowX: horizontal ? 'auto' : 'hidden',
        overflowY: horizontal ? 'hidden' : 'auto',
        ...flatStyle,
        ...flatContainerStyle
      }}
      className={horizontal && !showsHorizontalScrollIndicator ? 'no-scrollbar' : ''}
      {...props}
    >
      {ListHeaderComponent}
      {data?.map((item: any, index: number) => {
        const key = keyExtractor ? keyExtractor(item, index) : index;
        return <React.Fragment key={key}>{renderItem({ item, index })}</React.Fragment>;
      })}
    </div>
  );
});
FlatList.displayName = 'FlatList';

export const ScrollView = forwardRef<HTMLDivElement, any>(({ 
  style, 
  contentContainerStyle, 
  horizontal, 
  children, 
  showsHorizontalScrollIndicator, 
  showsVerticalScrollIndicator, 
  className, 
  ...props 
}, ref) => {
  const flatStyle = flattenStyle(style);
  const flatContainerStyle = flattenStyle(contentContainerStyle);

  return (
    <div 
      ref={ref} 
      style={{
        display: 'flex', 
        flexDirection: horizontal ? 'row' : 'column',
        overflowX: horizontal ? 'auto' : 'hidden',
        overflowY: horizontal ? 'hidden' : 'auto',
        ...flatStyle,
        ...flatContainerStyle
      }}
      className={className}
      {...props}
    >
      {children}
    </div>
  );
});
ScrollView.displayName = 'ScrollView';

export const Modal = ({ visible, transparent, children, onRequestClose }: any) => {
  if (!visible) return null;
  return (
    <div 
      style={{ position: 'fixed', inset: 0, zIndex: 9999, backgroundColor: transparent ? 'transparent' : 'black', display: 'flex', flexDirection: 'column' }}
    >
      {children}
    </div>
  );
};

// === Implementation of missing components/utilities ===
export const ActivityIndicator = ({ size, color, style }: any) => {
  const flatStyle = flattenStyle(style);
  return (
    <div style={flatStyle} className="flex justify-center items-center">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2" style={{ borderColor: color || 'white' }} />
    </div>
  );
};

export const StyleSheet = {
  create: (obj: any) => obj,
  absoluteFillObject: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  absoluteFill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  flatten: (style: any) => flattenStyle(style),
};

export const Platform = {
  OS: 'web',
  select: (obj: any) => obj.web || obj.default,
};

export const Dimensions = {
  get: () => ({ 
    width: typeof window !== 'undefined' ? window.innerWidth : 1920, 
    height: typeof window !== 'undefined' ? window.innerHeight : 1080 
  })
};

export function useWindowDimensions() {
  const [dim, setDim] = useState({ 
    width: typeof window !== 'undefined' ? window.innerWidth : 1920, 
    height: typeof window !== 'undefined' ? window.innerHeight : 1080 
  });
  
  useEffect(() => {
    const fn = () => setDim({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', fn);
    return () => window.removeEventListener('resize', fn);
  }, []);
  
  return dim;
}
