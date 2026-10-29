import React, { useEffect, useRef, useState } from 'react';
import { Modal, Platform, Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { Image } from 'expo-image';
import { X, ZoomIn, ZoomOut } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { normalizeGithubReadmeImageUrl } from '@/utils/readme-images';
import { REFERENCE_THEME } from '@/constants/theme';

function boundPan(value: number, imageSize: number, viewportSize: number, scale: number) {
  'worklet';
  const limit = Math.max(0, (imageSize * scale - viewportSize) / 2);
  return limit === 0 ? 0 : Math.max(-limit, Math.min(limit, value));
}

function NativeImageViewport({ children, zoom, onZoom, width, height, imageWidth, imageHeight }: {
  children: React.ReactNode; zoom: number; onZoom: (zoom: number) => void;
  width: number; height: number; imageWidth: number; imageHeight: number;
}) {
  const scale = useSharedValue(zoom);
  const x = useSharedValue(0), y = useSharedValue(0);
  const startScale = useSharedValue(zoom), startX = useSharedValue(0), startY = useSharedValue(0);
  const focalX = useSharedValue(0), focalY = useSharedValue(0);
  const panStartX = useSharedValue(0), panStartY = useSharedValue(0);
  useEffect(() => {
    scale.set(zoom);
    x.set(boundPan(x.get(), imageWidth, width, zoom));
    y.set(boundPan(y.get(), imageHeight, height, zoom));
  }, [zoom, width, height, imageWidth, imageHeight, scale, x, y]);
  const pinch = Gesture.Pinch()
    .onStart(event => {
      startScale.set(scale.get());
      startX.set(x.get()); startY.set(y.get());
      focalX.set(event.focalX - width / 2);
      focalY.set(event.focalY - height / 2);
    })
    .onUpdate(event => {
      const next = Math.max(1, Math.min(4, startScale.get() * event.scale));
      const factor = next / startScale.get();
      scale.set(next);
      // Keep the image point under the fingers stationary until an edge binds.
      x.set(boundPan(event.focalX - width / 2 - (focalX.get() - startX.get()) * factor, imageWidth, width, next));
      y.set(boundPan(event.focalY - height / 2 - (focalY.get() - startY.get()) * factor, imageHeight, height, next));
    })
    .onFinalize(() => { scheduleOnRN(onZoom, scale.get()); });
  const pan = Gesture.Pan().enabled(zoom > 1).maxPointers(1)
    .onStart(() => { panStartX.set(x.get()); panStartY.set(y.get()); })
    .onUpdate(event => {
      x.set(boundPan(panStartX.get() + event.translationX, imageWidth, width, scale.get()));
      y.set(boundPan(panStartY.get() + event.translationY, imageHeight, height, scale.get()));
    });
  const imageStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: x.get() }, { translateY: y.get() }, { scale: scale.get() }],
  }));
  return <GestureHandlerRootView style={{ flex: 1, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
    <GestureDetector gesture={Gesture.Simultaneous(pinch, pan)}>
      <View collapsable={false} style={{ width, height, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
        <Animated.View style={[{ width: imageWidth, height: imageHeight }, imageStyle]}>{children}</Animated.View>
      </View>
    </GestureDetector>
  </GestureHandlerRootView>;
}

/** The digest stays mounted underneath, preserving its scroll position. */
export function ReadmeImagePopup({ url, alt, onClose }: {url: string; alt: string; onClose: () => void}) {
  const {width,height}=useWindowDimensions();
  const insets=useSafeAreaInsets();
  const closeButton=useRef<View>(null);
  const horizontal=useRef<ScrollView>(null);
  const vertical=useRef<ScrollView>(null);
  const [zoom,setZoom]=useState(1);
  const [ratio,setRatio]=useState(16/9);
  const [failed,setFailed]=useState(false);
  const viewportWidth=Math.max(1,width-24);
  const viewportHeight=Math.max(1,height-insets.top-insets.bottom-140);
  const fittedWidth=Math.min(viewportWidth,viewportHeight*ratio);
  const fittedHeight=fittedWidth/ratio;
  const image = <Image accessibilityLabel={alt||'README image'} accessibilityRole="image" source={{uri:normalizeGithubReadmeImageUrl(url)}}
    contentFit="contain" cachePolicy="memory-disk" style={{width:fittedWidth*(Platform.OS==='web'?zoom:1),height:fittedHeight*(Platform.OS==='web'?zoom:1)}}
    onLoad={event=>{if(event.source.width>0&&event.source.height>0)setRatio(event.source.width/event.source.height);}}
    onError={()=>setFailed(true)}/>;
  const reset=()=>{
    setZoom(1);
    horizontal.current?.scrollTo({x:0,animated:false});
    vertical.current?.scrollTo({y:0,animated:false});
  };
  return <Modal transparent visible animationType="fade" presentationStyle="overFullScreen" statusBarTranslucent
    onShow={()=>closeButton.current?.focus()} onRequestClose={onClose}>
    <View style={{flex:1,backgroundColor:'rgba(0,0,0,0.96)',paddingHorizontal:12,
      paddingTop:insets.top+12,paddingBottom:insets.bottom+12}}>
      <View accessibilityViewIsModal style={{flex:1,gap:10}}>
        <View style={{flexDirection:'row',alignItems:'center',justifyContent:'space-between',gap:12}}>
          <Text numberOfLines={1} style={{flex:1,color:REFERENCE_THEME.textPrimary}}>{alt||'README image'}</Text>
          <Pressable ref={closeButton} accessibilityRole="button" accessibilityLabel="Close image and return to summary"
            onPress={onClose} style={{width:44,height:44,alignItems:'center',justifyContent:'center'}}>
            <X size={24} color={REFERENCE_THEME.textPrimary}/>
          </Pressable>
        </View>
        {failed ? <Text accessibilityRole="alert" style={{color:REFERENCE_THEME.textPrimary}}>This image could not be loaded.</Text>
          : Platform.OS !== 'web' ? <NativeImageViewport zoom={zoom} onZoom={setZoom} width={viewportWidth} height={viewportHeight}
            imageWidth={fittedWidth} imageHeight={fittedHeight}>{image}</NativeImageViewport>
          : <ScrollView ref={vertical} nestedScrollEnabled style={{flex:1}}
            contentContainerStyle={{minHeight:viewportHeight,justifyContent:'center'}}>
            <ScrollView ref={horizontal} horizontal nestedScrollEnabled
              contentContainerStyle={{minWidth:viewportWidth,alignItems:'center',justifyContent:'center'}}
              style={{height:Math.max(viewportHeight,fittedHeight*zoom)}}>
              {image}
            </ScrollView>
          </ScrollView>}
        <View style={{flexDirection:'row',justifyContent:'center',alignItems:'center',gap:20}}>
          <Pressable accessibilityRole="button" accessibilityLabel="Zoom out" disabled={zoom<=1||failed}
            onPress={()=>setZoom(value=>Math.max(1,value-0.5))} style={{padding:12,opacity:zoom<=1?0.4:1}}>
            <ZoomOut color={REFERENCE_THEME.textPrimary} size={24}/>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="Reset image zoom" onPress={reset} style={{padding:12}}>
            <Text style={{color:REFERENCE_THEME.textPrimary}}>{Math.round(zoom*100)}%</Text>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="Zoom in" disabled={zoom>=4||failed}
            onPress={()=>setZoom(value=>Math.min(4,value+0.5))} style={{padding:12,opacity:zoom>=4?0.4:1}}>
            <ZoomIn color={REFERENCE_THEME.textPrimary} size={24}/>
          </Pressable>
        </View>
      </View>
    </View>
  </Modal>;
}
