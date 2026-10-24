import React, { useRef, useState } from 'react';
import { Modal, Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { Image } from 'expo-image';
import { X, ZoomIn, ZoomOut } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { REFERENCE_THEME } from '@/constants/theme';

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
          : <ScrollView ref={vertical} nestedScrollEnabled style={{flex:1}}
            contentContainerStyle={{minHeight:viewportHeight,justifyContent:'center'}}>
            <ScrollView ref={horizontal} horizontal nestedScrollEnabled
              contentContainerStyle={{minWidth:viewportWidth,alignItems:'center',justifyContent:'center'}}
              style={{height:Math.max(viewportHeight,fittedHeight*zoom)}}>
              <Image accessibilityLabel={alt||'README image'} accessibilityRole="image" source={{uri:url}}
                contentFit="contain" cachePolicy="memory-disk" style={{width:fittedWidth*zoom,height:fittedHeight*zoom}}
                onLoad={event=>{if(event.source.width>0&&event.source.height>0)setRatio(event.source.width/event.source.height);}}
                onError={()=>setFailed(true)}/>
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
